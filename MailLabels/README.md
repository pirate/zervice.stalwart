# Stalwart Mail Labels for Mail.app

This macOS menu-bar companion gives Apple Mail a label-first control surface for
the Stalwart setup in this repository. Select one or more messages in Mail, then
use the tag icon in the menu bar to:

- archive while preserving every other mailbox membership;
- add the message to `Rules/AutoUnread`, `Rules/AutoRead`, `Rules/Ham`,
  `Rules/Spam`, or `Rules/Noreply` without moving it;
- add any mailbox label, including `Type/*`, without removing Inbox, Archive,
  `Autosorted/*`, or another label.

The companion reads only the selected Mail messages' Message-ID and account
identity through Mail's public AppleScript dictionary. It performs mailbox
updates directly through standard JMAP. Account passwords are stored in macOS
Keychain, not preferences or the repository.

## Why this is not a MailKit action extension

MailKit action handlers run when Mail downloads a message and may only mark it
read or unread, flag it, set its color, or move it to Archive, Junk, or Trash.
MailKit does not expose the user's later Archive/Move command, arbitrary
mailbox membership, the current message selection, or a custom message-viewer
UI. A MailKit target therefore cannot implement Gmail-style labels or repair
Mail's destructive Archive behavior.

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
