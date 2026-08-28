#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAIL_CAP = "urn:ietf:params:jmap:mail";
const SIEVE_CAP = "urn:ietf:params:jmap:sieve";
const CORE_CAP = "urn:ietf:params:jmap:core";
const WATCHER_SCRIPT = "rules-watcher";
const BEGIN_MARKER = "# BEGIN MAIL RULES WATCHER - MANAGED";
const END_MARKER = "# END MAIL RULES WATCHER - MANAGED";
const CONTROL_MODES = Object.freeze({
  AutoUnread: "autoUnread",
  AutoRead: "autoRead",
  Ham: "ham",
  Spam: "spam",
  Noreply: "noreply",
});
const PROTECTED_ROOT_MAILBOXES = new Set(["Rules", "Type", "Autosorted"]);

function env(name, fallback = undefined) {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const CONFIG = {
  baseUrl: env("JMAP_BASE_URL", "http://stalwart:8080").replace(/\/$/, ""),
  botUsername: env("RULES_BOT_USERNAME"),
  targets: env("RULES_TARGETS").split(",").map((value) => value.trim()).filter(Boolean),
  routes: JSON.parse(env("RULES_ROUTES")),
  copyForwards: JSON.parse(env("RULES_COPY_FORWARDS", "{}")),
  passwordFile: env("RULES_BOT_PASSWORD_FILE", "/run/secrets/bot_password"),
  statePath: env("RULES_STATE_PATH", "/data/state.json"),
  healthPath: env("RULES_HEALTH_PATH", "/data/healthy"),
  pollMs: Math.max(5, Number(env("RULES_POLL_SECONDS", "10"))) * 1000,
  emptyFolderPollMs: Math.max(60, Number(env("EMPTY_FOLDER_POLL_SECONDS", "3600"))) * 1000,
};

function localForwardedFor() {
  if (process.env.RULES_FORWARDED_FOR) return process.env.RULES_FORWARDED_FOR;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function log(level, message, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...details,
  }));
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(CONFIG.statePath, "utf8"));
    state.version ||= 1;
    state.accounts ||= {};
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, accounts: {} };
  }
}

function saveState(state) {
  const directory = path.dirname(CONFIG.statePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${CONFIG.statePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CONFIG.statePath);
}

function accountState(state, target) {
  state.accounts[target] ||= {
    policies: { autoUnread: {}, autoRead: {}, ham: {}, spam: {}, noreply: {} },
    processed: {},
    labeled: {},
  };
  const result = state.accounts[target];
  result.policies ||= { autoUnread: {}, autoRead: {}, ham: {}, spam: {}, noreply: {} };
  for (const mode of Object.values(CONTROL_MODES)) result.policies[mode] ||= {};
  result.processed ||= {};
  result.labeled ||= {};
  delete result.fallbackScript;
  return result;
}

function sieveQuote(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function folderNameFor(address) {
  const localPart = address.split("@", 1)[0];
  const cleaned = localPart.normalize("NFKC").replace(/[^A-Za-z0-9._+-]/g, "_");
  return (cleaned || "unknown").slice(0, 80);
}

function emptyLeafMailboxes(mailboxes) {
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const parents = new Set(mailboxes.map((mailbox) => mailbox.parentId).filter(Boolean));
  const pathFor = (mailbox) => {
    const names = [];
    const visited = new Set();
    while (mailbox) {
      if (visited.has(mailbox.id)) return null;
      visited.add(mailbox.id);
      names.unshift(mailbox.name);
      if (!mailbox.parentId) return names.join("/");
      mailbox = byId.get(mailbox.parentId);
    }
    return null;
  };
  return mailboxes.flatMap((mailbox) => {
    if (mailbox.role || mailbox.totalEmails !== 0 || parents.has(mailbox.id)) return [];
    if (!mailbox.parentId && PROTECTED_ROOT_MAILBOXES.has(mailbox.name)) return [];
    const path = pathFor(mailbox);
    if (!path || /^(Rules|Type)(?:\/|$)/.test(path)) return [];
    return [{ id: mailbox.id, path }];
  });
}

function renderManagedBlock(policies, copyForwards = {}) {
  const lines = [BEGIN_MARKER];
  for (const [source, destination] of Object.entries(copyForwards).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`# Exact-envelope copy forward. The original message remains in this account.`);
    lines.push(`if envelope :is "to" "${sieveQuote(source)}" {`);
    lines.push(`  redirect :copy "${sieveQuote(destination)}";`);
    lines.push("}");
    lines.push("");
  }
  for (const address of Object.keys(policies.noreply || {}).sort()) {
    lines.push(`if anyof (envelope :is "to" "${sieveQuote(address)}", address :is ["X-Original-To", "Envelope-To", "To", "Cc"] "${sieveQuote(address)}") {`);
    lines.push('  reject "This email address does not have an inbox, it is only meant for automated messages. Please find different contact info for your intended recipient or resend your message to a different email.";');
    lines.push("  stop;");
    lines.push("}");
    lines.push("");
  }
  const modes = ["ham", "spam", "autoUnread", "autoRead"];
  for (const mode of modes) {
    const addresses = Object.keys(policies[mode] || {}).sort();
    for (const address of addresses) {
      // Catch-all delivery rewrites the envelope recipient to the owning account
      // before the user's Sieve script runs. Match the original address retained
      // in recipient headers as well as a non-rewritten envelope recipient.
      lines.push(`if anyof (envelope :is "to" "${sieveQuote(address)}", address :is ["X-Original-To", "Envelope-To", "To", "Cc"] "${sieveQuote(address)}") {`);
      if (mode === "ham") {
        lines.push('  removeflag "\\\\Seen";');
        lines.push('  addflag "\\\\Flagged";');
        lines.push('  fileinto :create "Inbox";');
      } else if (mode === "spam") {
        lines.push('  removeflag "\\\\Seen";');
        lines.push('  addflag "$Junk";');
        lines.push('  removeflag "$NotJunk";');
        lines.push('  fileinto :specialuse "\\\\Junk" "Junk Mail";');
      } else {
        const folder = folderNameFor(address);
        if (mode === "autoRead") lines.push('  addflag "\\\\Seen";');
        else lines.push('  removeflag "\\\\Seen";');
        lines.push(`  fileinto :create "Autosorted/${sieveQuote(folder)}";`);
      }
      lines.push("  stop;");
      lines.push("}");
      lines.push("");
    }
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

function mergeManagedBlock(existing, managedBlock) {
  const extraExtensions = [];
  if (managedBlock.includes("llm_prompt(")) extraExtensions.push("variables", "vnd.stalwart.expressions");
  if (managedBlock.includes(":copy")) extraExtensions.push("copy");
  if (managedBlock.includes(":specialuse")) extraExtensions.push("special-use");
  if (managedBlock.includes("  reject ")) extraExtensions.push("reject");
  if (!existing) {
    const extensions = [
      ...(managedBlock.includes("envelope ") ? ["envelope"] : []),
      ...(managedBlock.includes("fileinto ") ? ["fileinto"] : []),
      ...(/\b(?:addflag|removeflag)\b/.test(managedBlock) ? ["imap4flags"] : []),
      ...(managedBlock.includes(":create") ? ["mailbox"] : []),
      ...extraExtensions,
    ];
    return [
      `require [${extensions.map((name) => `"${name}"`).join(", ")}];`,
      "",
      managedBlock,
      "",
    ].join("\n");
  }
  if (extraExtensions.length) {
    existing = existing.replace(/require\s+\[([^\]]*)\];/, (statement, names) => {
      const additions = extraExtensions
        .filter((name) => !names.includes(`"${name}"`))
        .map((name) => `, "${name}"`)
        .join("");
      return additions ? `require [${names}${additions}];` : statement;
    });
  }
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin >= 0 && end >= begin) {
    return `${existing.slice(0, begin)}${managedBlock}${existing.slice(end + END_MARKER.length)}`;
  }
  throw new Error(`${WATCHER_SCRIPT} exists without managed markers; refusing to overwrite it`);
}

function allAddressStrings(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item.email === "string") return [item.email];
      return [];
    });
  }
  return [];
}

function parseAddresses(value) {
  const results = [];
  for (const text of allAddressStrings(value)) {
    for (const match of text.matchAll(/(?:^|[<\s,(])([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?=$|[>\s,)])/gi)) {
      results.push(match[1].toLowerCase());
    }
  }
  return results;
}

function parseReceivedFor(value) {
  const results = [];
  for (const text of allAddressStrings(value)) {
    for (const match of text.matchAll(/\bfor\s+<?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/gi)) {
      results.push(match[1].toLowerCase());
    }
  }
  return results;
}

function extractDestination(email, allowedDomains, canonicalTarget = null) {
  const allowed = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  const valid = (address) => allowed.has(address.slice(address.lastIndexOf("@") + 1));
  const preferredHeaders = [
    "header:X-Original-To:asText",
    "header:Envelope-To:asText",
  ];
  for (const property of preferredHeaders) {
    const candidates = [...new Set(parseAddresses(email[property]).filter(valid))];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(`Ambiguous ${property}: ${candidates.join(", ")}`);
    }
  }
  const received = [...new Set(parseReceivedFor(email["header:Received:asText:all"]).filter(valid))];
  const originalReceived = canonicalTarget
    ? received.filter((address) => address !== canonicalTarget.toLowerCase())
    : received;
  if (originalReceived.length === 1) return originalReceived[0];
  if (originalReceived.length > 1) {
    throw new Error(`Ambiguous Received recipients: ${originalReceived.join(", ")}`);
  }
  if (received.length === 1) return received[0];
  const visible = [
    ...parseAddresses(email["header:To:asAddresses"]),
    ...parseAddresses(email["header:Cc:asAddresses"]),
  ].filter(valid);
  const candidates = [...new Set(visible)];
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    const delivered = [...new Set(parseAddresses(email["header:Delivered-To:asText"])
      .filter(valid)
      .filter((address) => !canonicalTarget || address !== canonicalTarget.toLowerCase()))];
    if (delivered.length === 1) return delivered[0];
  }
  throw new Error(candidates.length
    ? `Ambiguous visible recipients: ${candidates.join(", ")}`
    : "No destination address for a managed catch-all domain was found");
}

function extractLabelDestinations(email, allowedDomains) {
  const allowed = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  const valid = (address) => allowed.has(address.slice(address.lastIndexOf("@") + 1));
  const candidatesFrom = (value, parser = parseAddresses) => [
    ...new Set(parser(value).filter(valid)),
  ];
  for (const property of ["header:X-Original-To:asText", "header:Envelope-To:asText"]) {
    const candidates = candidatesFrom(email[property]);
    if (candidates.length) return candidates;
  }
  const received = candidatesFrom(email["header:Received:asText:all"], parseReceivedFor);
  if (received.length) return received;
  const visible = candidatesFrom([
    ...(email["header:To:asAddresses"] || []),
    ...(email["header:Cc:asAddresses"] || []),
  ]);
  if (visible.length) return visible;
  return candidatesFrom(email["header:Delivered-To:asText"]);
}

class JmapClient {
  constructor(target, password) {
    this.target = target;
    this.authorization = `Basic ${Buffer.from(`${target}%${CONFIG.botUsername}:${password}`).toString("base64")}`;
    this.session = null;
    this.accountId = null;
    this.forwardedFor = localForwardedFor();
  }

  internalUrl(url) {
    const base = new URL(CONFIG.baseUrl);
    const parsed = new URL(url, base);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  }

  async fetch(url, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          ...options,
          headers: {
            Authorization: this.authorization,
            "X-Forwarded-For": this.forwardedFor,
            ...(options.headers || {}),
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        if (attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (2 ** attempt), 10_000)));
        continue;
      }
      if (response.ok) return response;
      const body = (await response.text()).slice(0, 500);
      if (![429, 502, 503, 504].includes(response.status) || attempt >= 6) {
        throw new Error(`${options.method || "GET"} ${url}: HTTP ${response.status}: ${body}`);
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * (2 ** attempt), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async connect() {
    const response = await this.fetch(`${CONFIG.baseUrl}/jmap/session`);
    this.session = await response.json();
    this.accountId = this.session.primaryAccounts[MAIL_CAP];
    if (!this.accountId || !this.session.primaryAccounts[SIEVE_CAP]) {
      throw new Error(`${this.target} has no primary mail/Sieve account`);
    }
  }

  async request(methodCalls, using = [CORE_CAP, MAIL_CAP]) {
    if (!this.session) await this.connect();
    const response = await this.fetch(`${CONFIG.baseUrl}/jmap/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
    });
    const body = await response.json();
    for (const methodResponse of body.methodResponses || []) {
      if (methodResponse[0] === "error" || methodResponse[0].endsWith("/error")) {
        throw new Error(`${methodResponse[0]}: ${JSON.stringify(methodResponse[1])}`);
      }
    }
    return body.methodResponses || [];
  }

  result(responses, method, callId = null) {
    const response = responses.find((item) => item[0] === method && (!callId || item[2] === callId));
    if (!response) throw new Error(`Missing ${method} response`);
    return response[1];
  }

  async mailboxes() {
    const maximum = this.session.capabilities?.[CORE_CAP]?.maxObjectsInGet || 256;
    const ids = [];
    for (let position = 0; ; position += maximum) {
      const responses = await this.request([["Mailbox/query", {
        accountId: this.accountId,
        filter: {},
        position,
        limit: maximum,
      }, "query"]]);
      const page = this.result(responses, "Mailbox/query", "query").ids || [];
      ids.push(...page);
      if (page.length < maximum) break;
    }
    const mailboxes = [];
    for (let offset = 0; offset < ids.length; offset += maximum) {
      const responses = await this.request([["Mailbox/get", {
        accountId: this.accountId,
        ids: ids.slice(offset, offset + maximum),
        properties: ["id", "name", "parentId", "role", "isSubscribed"],
      }, "get"]]);
      mailboxes.push(...(this.result(responses, "Mailbox/get", "get").list || []));
    }
    return mailboxes;
  }

  async mailboxSnapshot() {
    const maximum = this.session.capabilities?.[CORE_CAP]?.maxObjectsInGet || 256;
    const stateResponses = await this.request([["Mailbox/get", {
      accountId: this.accountId,
      ids: [],
      properties: ["id"],
    }, "state"]]);
    const state = this.result(stateResponses, "Mailbox/get", "state").state;
    const ids = [];
    for (let position = 0; ; position += maximum) {
      const responses = await this.request([["Mailbox/query", {
        accountId: this.accountId,
        filter: {},
        position,
        limit: maximum,
      }, "query"]]);
      const page = this.result(responses, "Mailbox/query", "query").ids || [];
      ids.push(...page);
      if (page.length < maximum) break;
    }
    return { state, mailboxes: await this.mailboxDetails(ids) };
  }

  async mailboxDetails(ids) {
    if (!ids.length) return [];
    const maximum = this.session.capabilities?.[CORE_CAP]?.maxObjectsInGet || 256;
    const mailboxes = [];
    for (let offset = 0; offset < ids.length; offset += maximum) {
      const responses = await this.request([["Mailbox/get", {
        accountId: this.accountId,
        ids: ids.slice(offset, offset + maximum),
        properties: ["id", "name", "parentId", "role", "totalEmails"],
      }, "get"]]);
      mailboxes.push(...(this.result(responses, "Mailbox/get", "get").list || []));
    }
    return mailboxes;
  }

  async createMailbox(name, parentId = null) {
    const responses = await this.request([["Mailbox/set", {
      accountId: this.accountId,
      create: { mailbox: { name, parentId, isSubscribed: true } },
    }, "set"]]);
    const result = this.result(responses, "Mailbox/set", "set");
    if (result.notCreated?.mailbox) throw new Error(JSON.stringify(result.notCreated.mailbox));
    return result.created.mailbox.id;
  }

  async ensureMailbox(name, parentId = null) {
    const mailboxes = await this.mailboxes();
    const existing = mailboxes.find((mailbox) => mailbox.name === name && mailbox.parentId === parentId);
    if (!existing) return this.createMailbox(name, parentId);
    if (!existing.isSubscribed) {
      const responses = await this.request([["Mailbox/set", {
        accountId: this.accountId,
        update: { [existing.id]: { isSubscribed: true } },
      }, "subscribe"]]);
      const result = this.result(responses, "Mailbox/set", "subscribe");
      if (result.notUpdated?.[existing.id]) throw new Error(JSON.stringify(result.notUpdated[existing.id]));
    }
    return existing.id;
  }

  async ensureStandardMailboxes(account) {
    const mailboxes = await this.mailboxes();
    const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
    if (!inbox) throw new Error(`${this.target} has no Inbox`);
    const junk = mailboxes.find((mailbox) => mailbox.role === "junk");
    if (!junk) throw new Error(`${this.target} has no Junk mailbox`);
    const rules = await this.ensureMailbox("Rules", null);
    const autosorted = await this.ensureMailbox("Autosorted", null);
    const type = await this.ensureMailbox("Type", null);
    const controls = {};
    for (const control of Object.keys(CONTROL_MODES)) {
      const existing = mailboxes.find((mailbox) => mailbox.name === control && mailbox.parentId === rules);
      if (existing) {
        controls[control] = existing.id;
        continue;
      }
      controls[control] = await this.createMailbox(control, rules);
    }
    return { inbox: inbox.id, junk: junk.id, rules, autosorted, type, controls };
  }

  async emailIdsInMailbox(mailboxId) {
    const maximum = this.session.capabilities?.[CORE_CAP]?.maxObjectsInGet || 256;
    const ids = [];
    for (let position = 0; ; position += maximum) {
      const responses = await this.request([["Email/query", {
        accountId: this.accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: true }],
        position,
        limit: maximum,
      }, "query"]]);
      const page = this.result(responses, "Email/query", "query").ids || [];
      ids.push(...page);
      if (page.length < maximum) break;
    }
    return ids;
  }

  async recentEmailIds(after) {
    const maximum = this.session.capabilities?.[CORE_CAP]?.maxObjectsInGet || 256;
    const ids = [];
    for (let position = 0; position < maximum * 5; position += maximum) {
      const responses = await this.request([["Email/query", {
        accountId: this.accountId,
        filter: { after },
        sort: [{ property: "receivedAt", isAscending: false }],
        position,
        limit: maximum,
      }, "query"]]);
      const page = this.result(responses, "Email/query", "query").ids || [];
      ids.push(...page);
      if (page.length < maximum) break;
    }
    return ids;
  }

  async emails(ids) {
    if (!ids.length) return [];
    const responses = await this.request([["Email/get", {
      accountId: this.accountId,
      ids,
      properties: [
        "id", "mailboxIds", "keywords", "subject", "receivedAt",
        "header:Delivered-To:asText", "header:X-Original-To:asText",
        "header:Envelope-To:asText", "header:Received:asText:all",
        "header:To:asAddresses", "header:Cc:asAddresses",
      ],
    }, "get"]]);
    return this.result(responses, "Email/get", "get").list || [];
  }

  async moveEmail(email, mode, mailboxId, preserveMailboxes = false) {
    const keywords = { ...(email.keywords || {}) };
    if (mode === "autoRead" || mode === "noreply") keywords.$seen = true;
    else delete keywords.$seen;
    if (mode === "ham") keywords.$flagged = true;
    if (mode === "spam") {
      keywords.$junk = true;
      delete keywords.$notjunk;
      delete keywords.NotJunk;
    }
    const mailboxIds = preserveMailboxes
      ? { ...(email.mailboxIds || {}), [mailboxId]: true }
      : { [mailboxId]: true };
    const responses = await this.request([["Email/set", {
      accountId: this.accountId,
      update: { [email.id]: { mailboxIds, keywords } },
    }, "set"]]);
    const result = this.result(responses, "Email/set", "set");
    if (result.notUpdated?.[email.id]) throw new Error(JSON.stringify(result.notUpdated[email.id]));
    email.mailboxIds = mailboxIds;
    email.keywords = keywords;
  }

  async addMailboxMembership(email, mailboxId) {
    if (email.mailboxIds?.[mailboxId]) return;
    const mailboxIds = { ...(email.mailboxIds || {}), [mailboxId]: true };
    const responses = await this.request([["Email/set", {
      accountId: this.accountId,
      update: { [email.id]: { mailboxIds } },
    }, "set"]]);
    const result = this.result(responses, "Email/set", "set");
    if (result.notUpdated?.[email.id]) throw new Error(JSON.stringify(result.notUpdated[email.id]));
    email.mailboxIds = mailboxIds;
  }

  async scripts() {
    const responses = await this.request([["SieveScript/get", {
      accountId: this.accountId,
    }, "get"]], [CORE_CAP, SIEVE_CAP]);
    return this.result(responses, "SieveScript/get", "get").list || [];
  }

  async downloadBlob(blobId) {
    const template = this.session.downloadUrl
      .replace("{accountId}", encodeURIComponent(this.accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{name}", encodeURIComponent("rules.sieve"))
      .replace("{type}", encodeURIComponent("application/sieve"));
    return (await this.fetch(this.internalUrl(template))).text();
  }

  async uploadSieve(content) {
    const template = this.session.uploadUrl.replace("{accountId}", encodeURIComponent(this.accountId));
    const response = await this.fetch(this.internalUrl(template), {
      method: "POST",
      headers: { "Content-Type": "application/sieve" },
      body: content,
    });
    const result = await response.json();
    return result.blobId || result[this.accountId]?.blobId;
  }

  async ensureSieve(account, options = {}) {
    const scripts = await this.scripts();
    const active = scripts.find((script) => script.isActive);
    const watcher = scripts.find((script) => script.name === WATCHER_SCRIPT);
    if (active && active.name !== WATCHER_SCRIPT) {
      throw new Error(`Refusing to replace active Sieve script ${active.name}`);
    }
    const current = watcher ? await this.downloadBlob(watcher.blobId) : "";
    const managed = renderManagedBlock(
      account.policies,
      options.copyForwards ?? CONFIG.copyForwards[this.target] ?? {},
    );
    const content = mergeManagedBlock(current, managed);
    if (watcher && watcher.isActive && content === current) return;
    const blobId = await this.uploadSieve(content);
    if (!blobId) throw new Error("Sieve upload did not return a blobId");
    const validationResponses = await this.request([["SieveScript/validate", {
      accountId: this.accountId, blobId,
    }, "validate"]], [CORE_CAP, SIEVE_CAP]);
    const validation = this.result(validationResponses, "SieveScript/validate", "validate");
    if (validation.error) throw new Error(`Sieve validation failed: ${JSON.stringify(validation.error)}`);
    const setArgs = watcher
      ? { accountId: this.accountId, update: { [watcher.id]: { blobId } }, onSuccessActivateScript: watcher.id }
      : { accountId: this.accountId, create: { watcher: { name: WATCHER_SCRIPT, blobId } }, onSuccessActivateScript: "#watcher" };
    const responses = await this.request([["SieveScript/set", setArgs, "set"]], [CORE_CAP, SIEVE_CAP]);
    const result = this.result(responses, "SieveScript/set", "set");
    if (result.notCreated?.watcher || (watcher && result.notUpdated?.[watcher.id])) {
      throw new Error(`Sieve update failed: ${JSON.stringify(result.notCreated?.watcher || result.notUpdated[watcher.id])}`);
    }
  }
}

function clearPolicy(account, address) {
  for (const policyMode of Object.values(CONTROL_MODES)) {
    account.policies[policyMode] ||= {};
    delete account.policies[policyMode][address];
  }
}

function setPolicy(account, mode, address, selectorEmailId = null) {
  clearPolicy(account, address);
  account.policies[mode][address] = {
    updatedAt: new Date().toISOString(),
    ...(selectorEmailId ? { selectorEmailId } : {}),
  };
}

function reconcileSelectors(account, presentSelectorIds) {
  const removed = [];
  const affectedAddresses = new Set();
  for (const [id, record] of Object.entries(account.processed)) {
    if (!record.mode || !record.address || presentSelectorIds.has(id)) continue;
    removed.push({ id, ...record });
    affectedAddresses.add(record.address);
    delete account.processed[id];
  }

  const reactivated = [];
  const deactivated = [];
  for (const address of affectedAddresses) {
    const active = Object.entries(account.policies)
      .find(([, values]) => values[address]);
    if (!active) continue;
    const [activeMode, activePolicy] = active;
    const activeSelectorWasRemoved = activePolicy.selectorEmailId
      ? !presentSelectorIds.has(activePolicy.selectorEmailId)
      : removed.some((record) => record.mode === activeMode && record.address === address);
    if (!activeSelectorWasRemoved) continue;

    const fallback = Object.entries(account.processed)
      .filter(([id, record]) => presentSelectorIds.has(id)
        && record.address === address && record.mode && !record.error)
      .sort(([, left], [, right]) => Date.parse(right.processedAt || 0) - Date.parse(left.processedAt || 0))[0];
    if (fallback) {
      const [id, record] = fallback;
      setPolicy(account, record.mode, address, id);
      reactivated.push({ id, mode: record.mode, address });
    } else {
      clearPolicy(account, address);
      deactivated.push({ mode: activeMode, address });
    }
  }
  return { changed: Boolean(reactivated.length || deactivated.length), removed, reactivated, deactivated };
}

async function migrateSelectorFolders(account, client, folders, target) {
  if (account.selectorFoldersVersion === 1) return;
  for (const [mode, policies] of Object.entries(account.policies)) {
    const control = Object.entries(CONTROL_MODES).find(([, value]) => value === mode)?.[0];
    if (!control) continue;
    for (const [address, policy] of Object.entries(policies)) {
      if (policy.selectorEmailId) continue;
      const candidates = Object.entries(account.processed)
        .filter(([, record]) => record.mode === mode && record.address === address && !record.error)
        .sort(([, left], [, right]) => Date.parse(right.processedAt || 0) - Date.parse(left.processedAt || 0));
      for (const [id] of candidates) {
        const [email] = await client.emails([id]);
        if (!email) continue;
        await client.addMailboxMembership(email, folders.controls[control]);
        policy.selectorEmailId = id;
        log("info", "Restored rule selector to control folder", { target, mode, address, emailId: id });
        break;
      }
    }
  }
  account.selectorFoldersVersion = 1;
}

async function processAccount(state, target, password) {
  const account = accountState(state, target);
  const client = new JmapClient(target, password);
  await client.connect();
  let folders = await client.ensureStandardMailboxes(account);
  await client.ensureSieve(account);
  await migrateSelectorFolders(account, client, folders, target);

  // Every new message gets an Autosorted/<destination-localpart> membership.
  // This is independent of the Rules/* control folders and preserves Inbox/Junk.
  const after = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const recentIds = await client.recentEmailIds(after);
  const unlabeled = recentIds.filter((id) => !account.labeled[id]);
  for (const email of await client.emails(unlabeled)) {
    try {
      const addresses = extractLabelDestinations(email, CONFIG.routes[target] || []);
      if (!addresses.length) throw new Error("No managed destination address found");
      const labels = [];
      for (const address of addresses) {
        const mailboxId = await client.ensureMailbox(folderNameFor(address), folders.autosorted);
        await client.addMailboxMembership(email, mailboxId);
        labels.push(folderNameFor(address));
      }
      account.labeled[email.id] = { addresses, labeledAt: new Date().toISOString() };
      log("info", "Applied destination label", { target, emailId: email.id, labels });
    } catch (error) {
      account.labeled[email.id] = { error: error.message, labeledAt: new Date().toISOString() };
      log("error", "Unable to apply destination label", { target, emailId: email.id, error: error.message });
    }
    saveState(state);
  }

  const presentSelectorIds = new Set();
  for (const [control, mode] of Object.entries(CONTROL_MODES)) {
    const ids = await client.emailIdsInMailbox(folders.controls[control]);
    for (const id of ids) presentSelectorIds.add(id);
    const pending = ids.filter((id) => !account.processed[id] || account.processed[id].mode !== mode);
    for (const email of await client.emails(pending)) {
      try {
        const address = extractDestination(email, CONFIG.routes[target] || [], target);
        const previous = structuredClone(account.policies);
        setPolicy(account, mode, address, email.id);
        try {
          folders = await client.ensureStandardMailboxes(account);
          await client.ensureSieve(account);
        } catch (error) {
          account.policies = previous;
          throw error;
        }
        const aliasMailbox = await client.ensureMailbox(folderNameFor(address), folders.autosorted);
        const destination = mode === "ham"
          ? folders.inbox
          : mode === "spam"
            ? folders.junk
            : aliasMailbox;
        await client.moveEmail(email, mode, destination, true);
        if (destination !== aliasMailbox) await client.addMailboxMembership(email, aliasMailbox);
        account.processed[email.id] = { mode, address, processedAt: new Date().toISOString() };
        log("info", "Rule updated from control folder", { target, mode, address, emailId: email.id });
        saveState(state);
      } catch (error) {
        account.processed[email.id] = { error: error.message, processedAt: new Date().toISOString() };
        log("error", "Unable to process control message", {
          target, mode, emailId: email.id, error: error.message,
        });
        saveState(state);
      }
    }
  }

  const reconciliation = reconcileSelectors(account, presentSelectorIds);
  if (reconciliation.changed) {
    await client.ensureSieve(account);
    for (const record of reconciliation.deactivated) {
      log("info", "Rule removed with selector", { target, ...record });
    }
    for (const record of reconciliation.reactivated) {
      log("info", "Rule reverted to remaining selector", { target, ...record });
    }
    saveState(state);
  }

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const [id, record] of Object.entries(account.processed)) {
    if (!presentSelectorIds.has(id) && Date.parse(record.processedAt || 0) < cutoff) delete account.processed[id];
  }
  const labelCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, record] of Object.entries(account.labeled)) {
    if (Date.parse(record.labeledAt || 0) < labelCutoff) delete account.labeled[id];
  }
}

async function processForwardOnlyAccount(target, password) {
  const client = new JmapClient(target, password);
  await client.connect();
  await client.ensureSieve({
    policies: { autoUnread: {}, autoRead: {}, ham: {}, spam: {}, noreply: {} },
  }, {
    copyForwards: CONFIG.copyForwards[target] || {},
  });
}

async function syncMailboxTracker(tracker) {
  for (;;) {
    const responses = await tracker.client.request([["Mailbox/changes", {
      accountId: tracker.client.accountId,
      sinceState: tracker.state,
      maxChanges: 256,
    }, "changes"]]);
    const changes = tracker.client.result(responses, "Mailbox/changes", "changes");
    for (const id of changes.destroyed || []) tracker.mailboxes.delete(id);
    const changedIds = [...new Set([...(changes.created || []), ...(changes.updated || [])])];
    for (const mailbox of await tracker.client.mailboxDetails(changedIds)) {
      tracker.mailboxes.set(mailbox.id, mailbox);
    }
    tracker.state = changes.newState;
    if (!changes.hasMoreChanges) return;
  }
}

async function cleanEmptyMailboxes(tracker) {
  await syncMailboxTracker(tracker);
  const removed = [];
  const maximum = tracker.client.session.capabilities?.[CORE_CAP]?.maxObjectsInSet || 256;
  for (;;) {
    const empty = emptyLeafMailboxes([...tracker.mailboxes.values()]);
    if (!empty.length) return removed;
    const batch = empty.slice(0, maximum);
    const responses = await tracker.client.request([["Mailbox/set", {
      accountId: tracker.client.accountId,
      destroy: batch.map((mailbox) => mailbox.id),
      onDestroyRemoveEmails: false,
    }, "destroy"]]);
    const result = tracker.client.result(responses, "Mailbox/set", "destroy");
    if (Object.keys(result.notDestroyed || {}).length) {
      throw new Error(`Unable to remove empty mailboxes: ${JSON.stringify(result.notDestroyed)}`);
    }
    for (const mailbox of batch) {
      tracker.mailboxes.delete(mailbox.id);
      removed.push(mailbox.path);
    }
    tracker.state = result.newState || tracker.state;
  }
}

const accountLocks = new Map();

function withAccountLock(target, task) {
  const previous = accountLocks.get(target) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  accountLocks.set(target, current);
  return current.finally(() => {
    if (accountLocks.get(target) === current) accountLocks.delete(target);
  });
}

async function cycle(state, password) {
  const failures = [];
  for (const target of CONFIG.targets) {
    try {
      await withAccountLock(target, () => processAccount(state, target, password));
    } catch (error) {
      failures.push(`${target}: ${error.message}`);
      log("error", "Account cycle failed", { target, error: error.stack || error.message });
    }
  }
  for (const target of Object.keys(CONFIG.copyForwards).filter((value) => !CONFIG.targets.includes(value))) {
    try {
      await withAccountLock(target, () => processForwardOnlyAccount(target, password));
    } catch (error) {
      failures.push(`${target}: ${error.message}`);
      log("error", "Forward-only account cycle failed", { target, error: error.stack || error.message });
    }
  }
  saveState(state);
  if (failures.length) throw new Error(failures.join("; "));
  fs.writeFileSync(CONFIG.healthPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

async function emptyFolderLoop(password) {
  const trackers = new Map();
  // Give IMAP clients a full cleanup interval to observe mailbox changes
  // before the first destructive pass after a watcher restart.
  await new Promise((resolve) => setTimeout(resolve, CONFIG.emptyFolderPollMs));
  for (;;) {
    const startedAt = Date.now();
    for (const target of CONFIG.targets) {
      try {
        await withAccountLock(target, async () => {
          let tracker = trackers.get(target);
          if (!tracker) {
            const client = new JmapClient(target, password);
            await client.connect();
            const snapshot = await client.mailboxSnapshot();
            tracker = {
              client,
              state: snapshot.state,
              mailboxes: new Map(snapshot.mailboxes.map((mailbox) => [mailbox.id, mailbox])),
            };
            trackers.set(target, tracker);
          }
          const removed = await cleanEmptyMailboxes(tracker);
          if (removed.length) log("info", "Removed empty mailboxes", { target, mailboxes: removed });
        });
      } catch (error) {
        trackers.delete(target);
        log("error", "Empty mailbox cleanup failed", { target, error: error.stack || error.message });
      }
    }
    const remaining = CONFIG.emptyFolderPollMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

async function rulesLoop(password) {
  do {
    const state = loadState();
    await cycle(state, password);
    if (process.argv.includes("--once")) return;
    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollMs));
  } while (true);
}

async function main() {
  const password = fs.readFileSync(CONFIG.passwordFile, "utf8").trim();
  if (!password) throw new Error("Rules bot password file is empty");
  if (process.argv.includes("--status")) {
    const state = loadState();
    const targets = [...new Set([...CONFIG.targets, ...Object.keys(CONFIG.copyForwards)])];
    for (const target of targets) {
      const client = new JmapClient(target, password);
      await client.connect();
      const mailboxes = await client.mailboxes();
      const scripts = await client.scripts();
      if (!CONFIG.targets.includes(target)) {
        log("info", "Forward-only account status", {
          target,
          accountId: client.accountId,
          activeScript: scripts.find((script) => script.isActive)?.name || null,
          copyForwards: CONFIG.copyForwards[target] || {},
        });
        continue;
      }
      const account = accountState(state, target);
      const rules = mailboxes.find((mailbox) => mailbox.name === "Rules" && mailbox.parentId === null);
      const controls = rules
        ? mailboxes.filter((mailbox) => mailbox.parentId === rules.id).map((mailbox) => mailbox.name).sort()
        : [];
      log("info", "Account status", {
        target,
        accountId: client.accountId,
        controls,
        hasAutosorted: mailboxes.some((mailbox) => mailbox.name === "Autosorted" && mailbox.parentId === null),
        activeScript: scripts.find((script) => script.isActive)?.name || null,
        policies: Object.fromEntries(Object.entries(account.policies).map(([mode, values]) => [mode, Object.keys(values).length])),
      });
    }
    return;
  }
  if (process.argv.includes("--once")) return rulesLoop(password);
  await Promise.all([rulesLoop(password), emptyFolderLoop(password)]);
}

if (require.main === module) {
  main().catch((error) => {
    log("error", "Fatal watcher error", { error: error.stack || error.message });
    process.exit(1);
  });
}

module.exports = {
  CONFIG,
  CONTROL_MODES,
  JmapClient,
  accountState,
  cleanEmptyMailboxes,
  emptyLeafMailboxes,
  extractDestination,
  extractLabelDestinations,
  folderNameFor,
  loadState,
  mergeManagedBlock,
  parseAddresses,
  parseReceivedFor,
  renderManagedBlock,
  reconcileSelectors,
  saveState,
  setPolicy,
};
