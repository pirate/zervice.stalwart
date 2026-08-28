#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const {
  CONFIG,
  JmapClient,
  extractLabelDestinations,
  folderNameFor,
} = require("./watcher.js");

const CHECKPOINT_PATH = "/data/backfill-state.json";

function saveCheckpoint(value) {
  const temporary = `${CHECKPOINT_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CHECKPOINT_PATH);
}

async function allEmailIds(client) {
  const pageSize = client.session.capabilities?.["urn:ietf:params:jmap:core"]?.maxObjectsInGet || 256;
  const ids = [];
  for (let position = 0; ; position += pageSize) {
    const responses = await client.request([["Email/query", {
      accountId: client.accountId,
      filter: {},
      sort: [{ property: "receivedAt", isAscending: true }],
      position,
      limit: pageSize,
    }, "query"]]);
    const page = client.result(responses, "Email/query", "query").ids || [];
    ids.push(...page);
    if (page.length < pageSize) break;
  }
  return ids;
}

async function updateMemberships(client, updates) {
  if (!Object.keys(updates).length) return;
  const responses = await client.request([["Email/set", {
    accountId: client.accountId,
    update: updates,
  }, "set"]]);
  const result = client.result(responses, "Email/set", "set");
  if (Object.keys(result.notUpdated || {}).length) {
    throw new Error(`Email/set failures: ${JSON.stringify(result.notUpdated)}`);
  }
}

async function backfillAccount(target, password, checkpoint) {
  const client = new JmapClient(target, password);
  await client.connect();
  let mailboxes = await client.mailboxes();
  const autosorted = mailboxes.find((mailbox) => mailbox.name === "Autosorted" && mailbox.parentId === null);
  if (!autosorted) throw new Error(`${target} has no Autosorted root`);
  const childrenByName = new Map(
    mailboxes.filter((mailbox) => mailbox.parentId === autosorted.id).map((mailbox) => [mailbox.name, mailbox.id]),
  );
  const childIds = new Set(childrenByName.values());
  const ids = await allEmailIds(client);
  const batchSize = Math.min(
    client.session.capabilities?.["urn:ietf:params:jmap:core"]?.maxObjectsInSet || 128,
    client.session.capabilities?.["urn:ietf:params:jmap:core"]?.maxObjectsInGet || 128,
    128,
  );
  const stats = { total: ids.length, examined: 0, alreadyLabeled: 0, labeled: 0, fallback: 0 };
  checkpoint.accounts[target] = { ...stats, startedAt: new Date().toISOString() };
  saveCheckpoint(checkpoint);

  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const emails = await client.emails(ids.slice(offset, offset + batchSize));
    const updates = {};
    for (const email of emails) {
      stats.examined += 1;
      let addresses = extractLabelDestinations(email, CONFIG.routes[target] || []);
      if (!addresses.length) {
        addresses = [target];
        stats.fallback += 1;
      }
      const mailboxIds = { ...(email.mailboxIds || {}) };
      const expectedMailboxIds = [];
      for (const address of addresses) {
        const name = folderNameFor(address);
        let mailboxId = childrenByName.get(name);
        if (!mailboxId) {
          mailboxId = await client.createMailbox(name, autosorted.id);
          childrenByName.set(name, mailboxId);
          childIds.add(mailboxId);
        }
        expectedMailboxIds.push(mailboxId);
      }
      if (expectedMailboxIds.every((mailboxId) => mailboxIds[mailboxId])) {
        stats.alreadyLabeled += 1;
        continue;
      }
      for (const mailboxId of expectedMailboxIds) mailboxIds[mailboxId] = true;
      updates[email.id] = { mailboxIds };
      stats.labeled += 1;
    }
    await updateMemberships(client, updates);
    checkpoint.accounts[target] = { ...stats, updatedAt: new Date().toISOString() };
    saveCheckpoint(checkpoint);
    if (stats.examined % 1024 < batchSize || stats.examined === stats.total) {
      console.log(JSON.stringify({ target, ...stats }));
    }
  }
  checkpoint.accounts[target].completedAt = new Date().toISOString();
  saveCheckpoint(checkpoint);
  return stats;
}

async function main() {
  const password = fs.readFileSync(CONFIG.passwordFile, "utf8").trim();
  const checkpoint = { startedAt: new Date().toISOString(), accounts: {} };
  for (const target of CONFIG.targets) {
    await backfillAccount(target, password, checkpoint);
  }
  checkpoint.completedAt = new Date().toISOString();
  saveCheckpoint(checkpoint);
  console.log(JSON.stringify({ completed: true, accounts: checkpoint.accounts }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
