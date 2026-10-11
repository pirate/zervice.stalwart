# Stalwart Mail Labels for Mail.app

This macOS companion gives Apple Mail a label-first control surface for the
Stalwart setup in this repository. While Mail is frontmost, the **Stalwart
Labels** control is attached to the right side of the main inbox toolbar. Select
one or more messages, then use it to:

- archive while preserving every other mailbox membership;
- add the message to `Rules/AutoUnread`, `Rules/AutoRead`, `Rules/Ham`,
  `Rules/Spam`, or `Rules/Noreply` without moving it;
- add any mailbox label, including `Type/*`, without removing Inbox, Archive,
  `Autosorted/*`, or another label.

The companion reads only the selected Mail messages' Message-ID and account
identity through Mail's public AppleScript dictionary. It performs mailbox
updates directly through standard JMAP. Account passwords are stored in macOS
Keychain, not preferences or the repository.

The menu-bar tag remains available as a fallback and exposes the same actions.

## Why the inbox control is a companion panel

MailKit action handlers run when Mail downloads a message and may only mark it
read or unread, flag it, set its color, or move it to Archive, Junk, or Trash.
MailKit does not expose the user's current inbox selection or arbitrary mailbox
membership. A generic macOS Action extension can appear in Mail's toolbar
customizer, but Mail does not pass selected message rows to it, so that toolbar
item remains disabled. The functional inbox control is therefore a small native,
out-of-process panel aligned with Mail's toolbar; it does not inject code into
Mail or depend on private Mail plug-in APIs.

The durable fix is split at the correct boundaries:

1. `rules-watcher` follows JMAP `Email/changes` and restores the required
   `Autosorted/<destination>` membership after any IMAP client removes it.
2. This native companion provides explicit, additive actions for selected
   messages. It never replaces the message's mailbox set.

## Build and run

```bash
cd MailLabels
swift test
./scripts/build-app.sh
ditto -x -k "dist/Stalwart Mail Labels.zip" /Applications
open "/Applications/Stalwart Mail Labels.app"
```

On first use, macOS asks for permission to control Mail. Add both active
Stalwart accounts in Settings with **Import from Mail**, remove unrelated IMAP
accounts, and enter each password. The account email must match an email address
configured for that account in Mail.

The app is ad-hoc signed for local use. A Developer ID build can use the same
sources and bundle identifier if distribution is needed later.
