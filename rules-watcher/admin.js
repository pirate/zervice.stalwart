#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const {
  CONFIG,
  CONTROL_MODES,
  JmapClient,
  accountState,
  loadState,
  saveState,
} = require("./watcher.js");

async function main() {
  const [command, target, rawAddress] = process.argv.slice(2);
  const address = rawAddress?.toLowerCase();
  if (command !== "remove" || !target || !address) {
    throw new Error("Usage: node admin.js remove <target-account> <destination-address>");
  }
  const state = loadState();
  const account = accountState(state, target);
  for (const mode of Object.values(CONTROL_MODES)) delete account.policies[mode][address];
  for (const [id, record] of Object.entries(account.processed)) {
    if (record.address === address) delete account.processed[id];
  }
  const password = fs.readFileSync(CONFIG.passwordFile, "utf8").trim();
  const client = new JmapClient(target, password);
  await client.connect();
  await client.ensureSieve(account);
  saveState(state);
  console.log(JSON.stringify({ removed: address, target }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
