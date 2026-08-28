"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.RULES_BOT_USERNAME = "rules-bot@example.test";
process.env.RULES_TARGETS = "owner@primary.test,owner@archive.test";
process.env.RULES_ROUTES = JSON.stringify({
  "owner@primary.test": ["primary.test", "alias.test", "admin.test", "service.test"],
  "owner@archive.test": ["archive.test"],
});
process.env.RULES_COPY_FORWARDS = JSON.stringify({
  "admin@admin.test": { "admin@admin.test": "owner@primary.test" },
});

const {
  CONFIG,
  CONTROL_MODES,
  extractDestination,
  extractLabelDestinations,
  emptyLeafMailboxes,
  folderNameFor,
  JmapClient,
  mergeManagedBlock,
  reconcileSelectors,
  renderManagedBlock,
  setPolicy,
} = require("./watcher.js");

test("extractDestination prefers original recipient over final Delivered-To", () => {
  const email = {
    "header:Delivered-To:asText": "owner@primary.test",
    "header:Received:asText:all": ["from mx.example for <hotel@primary.test>; Tue"],
    "header:To:asAddresses": [{ email: "hotel@primary.test" }],
  };
  assert.equal(extractDestination(email, ["primary.test"], "owner@primary.test"), "hotel@primary.test");
});

test("extractDestination ignores the canonical catch-all recipient in Received", () => {
  const email = {
    "header:Received:asText:all": [
      "from mx.example for <owner@archive.test>; Tue",
      "from relay.example for <package@archive.test>; Tue",
    ],
  };
  assert.equal(
    extractDestination(email, ["archive.test"], "owner@archive.test"),
    "package@archive.test",
  );
});

test("extractDestination refuses canonical Delivered-To without original evidence", () => {
  assert.throws(() => extractDestination({
    "header:Delivered-To:asText": "admin@admin.test",
  }, ["admin.test"], "admin@admin.test"), /No destination/);
});

test("extractDestination rejects ambiguity", () => {
  assert.throws(() => extractDestination({
    "header:To:asAddresses": [
      { email: "one@admin.test" },
      { email: "two@service.test" },
    ],
  }, ["admin.test", "service.test"]), /Ambiguous/);
});

test("destination labels include every local catch-all recipient", () => {
  const email = {
    "header:To:asAddresses": [
      { email: "one@admin.test" },
      { email: "outside@example.net" },
      { email: "two@service.test" },
    ],
  };
  assert.deepEqual(extractLabelDestinations(email, ["admin.test", "service.test"]), [
    "one@admin.test", "two@service.test",
  ]);
});

test("primary account loads configured catch-all domains", () => {
  assert.deepEqual(CONFIG.routes["owner@primary.test"], [
    "primary.test", "alias.test", "admin.test", "service.test",
  ]);
});

test("admin exact-address forwarding keeps the local copy", () => {
  assert.equal(CONFIG.targets.includes("admin@admin.test"), false);
  assert.deepEqual(CONFIG.copyForwards["admin@admin.test"], {
    "admin@admin.test": "owner@primary.test",
  });
  const rendered = mergeManagedBlock("", renderManagedBlock({
    autoUnread: {}, autoRead: {}, ham: {}, spam: {}, noreply: {},
  }, CONFIG.copyForwards["admin@admin.test"]));
  assert.match(rendered, /"copy"/);
  assert.match(rendered, /if envelope :is "to" "admin@admin\.test" \{/);
  assert.match(rendered, /redirect :copy "owner@primary\.test";/);
  assert.match(rendered, /^require \["envelope", "copy"\];/);
  assert.doesNotMatch(rendered, /address :is .*admin@admin\.test/);
  assert.doesNotMatch(rendered, /llm_prompt|fileinto|imap4flags|mailbox|vnd\.stalwart|variables|Autosorted|Type\//);
});

test("destination labels accept a direct canonical Delivered-To fallback", () => {
  assert.deepEqual(extractLabelDestinations({
    "header:Delivered-To:asText": "admin@admin.test",
  }, ["admin.test"]), ["admin@admin.test"]);
});

test("Ham is the control mailbox for the ham policy", () => {
  assert.equal(CONTROL_MODES.Ham, "ham");
});

test("setPolicy makes modes mutually exclusive", () => {
  const account = { policies: { autoUnread: {}, autoRead: {}, ham: {}, noreply: {} } };
  setPolicy(account, "autoUnread", "foo@admin.test");
  setPolicy(account, "noreply", "foo@admin.test");
  assert.deepEqual(Object.keys(account.policies.autoUnread), []);
  assert.deepEqual(Object.keys(account.policies.noreply), ["foo@admin.test"]);
});

test("removing the active selector deactivates its rule", () => {
  const account = {
    policies: {
      autoUnread: {},
      autoRead: { "foo@admin.test": { selectorEmailId: "selector" } },
      ham: {}, spam: {}, noreply: {},
    },
    processed: {
      selector: { mode: "autoRead", address: "foo@admin.test", processedAt: "2026-08-25T00:00:00Z" },
    },
  };
  const result = reconcileSelectors(account, new Set());
  assert.equal(result.changed, true);
  assert.deepEqual(account.policies.autoRead, {});
  assert.deepEqual(account.processed, {});
});

test("removing the newest selector restores an older pinned selector", () => {
  const account = {
    policies: {
      autoUnread: {}, autoRead: {},
      ham: { "foo@admin.test": { selectorEmailId: "new" } },
      spam: {}, noreply: {},
    },
    processed: {
      old: { mode: "autoRead", address: "foo@admin.test", processedAt: "2026-08-24T00:00:00Z" },
      new: { mode: "ham", address: "foo@admin.test", processedAt: "2026-08-25T00:00:00Z" },
    },
  };
  const result = reconcileSelectors(account, new Set(["old"]));
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(account.policies.ham), []);
  assert.equal(account.policies.autoRead["foo@admin.test"].selectorEmailId, "old");
});

test("control processing can preserve the Rules mailbox membership", async () => {
  const client = new JmapClient("admin@example.com", "secret");
  client.accountId = "account";
  let update;
  client.request = async (calls) => {
    update = calls[0][1].update.message;
    return [["Email/set", { updated: { message: null } }, "set"]];
  };
  const email = { id: "message", mailboxIds: { rules: true }, keywords: {} };
  await client.moveEmail(email, "ham", "inbox", true);
  assert.deepEqual(update.mailboxIds, { rules: true, inbox: true });
  assert.equal(update.keywords.$flagged, true);
});

test("Noreply rejects with a short plain-text notice", () => {
  const rendered = mergeManagedBlock("", renderManagedBlock({
    autoUnread: {}, autoRead: {}, ham: {}, spam: {},
    noreply: { "package@archive.test": {} },
  }));
  assert.match(rendered, /"reject"/);
  assert.match(rendered, /reject "This email address does not have an inbox, it is only meant for automated messages\. Please find different contact info for your intended recipient or resend your message to a different email\.";/);
  assert.match(rendered, /address :is \["X-Original-To", "Envelope-To", "To", "Cc"\] "package@archive\.test"/);
});

test("managed Sieve preserves surrounding content", () => {
  const block1 = renderManagedBlock({
    autoUnread: { "news@primary.test": {} }, autoRead: {}, ham: {},
  });
  const initial = mergeManagedBlock("", block1);
  const withExternalRule = `${initial}\n# external rule\n`;
  const block2 = renderManagedBlock({
    autoUnread: {}, autoRead: { "news@primary.test": {} }, ham: {},
  });
  const updated = mergeManagedBlock(withExternalRule, block2);
  assert.match(updated, /addflag "\\\\Seen"/);
  assert.match(updated, /# external rule/);
});

test("managed Sieve matches catch-all aliases retained in recipient headers", () => {
  const rendered = renderManagedBlock({
    autoUnread: { "hotel@example.com": { updatedAt: "now" } },
    autoRead: {},
    ham: {},
  });
  assert.match(rendered, /address :is \["X-Original-To", "Envelope-To", "To", "Cc"\] "hotel@example\.com"/);
});

test("folder names are bounded and safe", () => {
  assert.equal(folderNameFor("hello world@primary.test"), "hello_world");
  assert.ok(folderNameFor(`${"a".repeat(200)}@primary.test`).length <= 80);
});

test("JMAP relative blob URLs resolve against the internal server", () => {
  const client = new JmapClient("admin@example.com", "secret");
  assert.equal(client.internalUrl("/jmap/download/id/blob/name"), "http://stalwart:8080/jmap/download/id/blob/name");
});

test("ensureMailbox subscribes an existing managed mailbox", async () => {
  const client = new JmapClient("owner@example.com", "secret");
  client.accountId = "account";
  client.mailboxes = async () => [{
    id: "existing", name: "amazon", parentId: "autosorted", isSubscribed: false,
  }];
  let update;
  client.request = async (calls) => {
    update = calls[0][1].update;
    return [["Mailbox/set", { updated: { existing: null } }, "subscribe"]];
  };
  assert.equal(await client.ensureMailbox("amazon", "autosorted"), "existing");
  assert.deepEqual(update, { existing: { isSubscribed: true } });
});

test("empty folder cleanup protects managed trees and special-use mailboxes", () => {
  const mailboxes = [
    { id: "rules", name: "Rules", parentId: null, role: null, totalEmails: 0 },
    { id: "spam", name: "Spam", parentId: "rules", role: null, totalEmails: 0 },
    { id: "type", name: "Type", parentId: null, role: null, totalEmails: 0 },
    { id: "category", name: "Category", parentId: "type", role: null, totalEmails: 0 },
    { id: "autosorted", name: "Autosorted", parentId: null, role: null, totalEmails: 0 },
    { id: "alias", name: "unused", parentId: "autosorted", role: null, totalEmails: 0 },
    { id: "inbox", name: "Inbox", parentId: null, role: "inbox", totalEmails: 0 },
    { id: "empty", name: "Empty", parentId: null, role: null, totalEmails: 0 },
    { id: "nonempty", name: "Nonempty", parentId: null, role: null, totalEmails: 1 },
    { id: "parent", name: "Parent", parentId: null, role: null, totalEmails: 0 },
    { id: "child", name: "Child", parentId: "parent", role: null, totalEmails: 0 },
    { id: "orphan", name: "Orphan", parentId: "missing", role: null, totalEmails: 0 },
  ];
  assert.deepEqual(emptyLeafMailboxes(mailboxes), [
    { id: "alias", path: "Autosorted/unused" },
    { id: "empty", path: "Empty" },
    { id: "child", path: "Parent/Child" },
  ]);
});

test("mailbox snapshots paginate instead of truncating the hierarchy", async () => {
  const client = new JmapClient("admin@example.com", "secret");
  client.accountId = "account";
  client.session = { capabilities: { "urn:ietf:params:jmap:core": { maxObjectsInGet: 2 } } };
  const details = {
    a: { id: "a", name: "A", parentId: null, role: null, totalEmails: 0 },
    b: { id: "b", name: "B", parentId: "a", role: null, totalEmails: 0 },
    c: { id: "c", name: "C", parentId: null, role: null, totalEmails: 1 },
  };
  client.request = async (calls) => {
    const [method, args, callId] = calls[0];
    if (method === "Mailbox/get" && args.ids.length === 0) {
      return [[method, { state: "state-1", list: [] }, callId]];
    }
    if (method === "Mailbox/query") {
      return [[method, { ids: args.position === 0 ? ["a", "b"] : ["c"] }, callId]];
    }
    return [[method, { state: "state-1", list: args.ids.map((id) => details[id]) }, callId]];
  };
  const snapshot = await client.mailboxSnapshot();
  assert.equal(snapshot.state, "state-1");
  assert.deepEqual(snapshot.mailboxes.map((mailbox) => mailbox.id), ["a", "b", "c"]);
});
