# Mail rules watcher

This internal service turns three IMAP/JMAP control mailboxes into persistent
Stalwart Sieve policy:

- `Rules/AutoUnread`: future mail for the same destination is delivered unread
  to `Autosorted/<localpart>`.
- `Rules/AutoRead`: future mail is delivered read to the same destination.
- `Rules/Ham`: future mail is forced to Inbox, unread and flagged.
- `Rules/Spam`: future mail is moved unread to the account's special-use Junk
  mailbox and removed from Inbox.
- `Rules/Noreply`: future mail is rejected without being stored, with the plain
  notice: `This email address does not have an inbox, it is only meant for automated messages. Please find different contact info for your intended recipient or resend your message to a different email.`

The message used to select a rule remains visible in its `Rules/*` folder and
is the rule's source of truth. Move or delete that selector message from the
control folder to remove the rule. If multiple selector messages exist for the
same destination, removing the newest one restores the most recently selected
rule that still has a message in a control folder.

The destination address is taken from `Delivered-To`, `X-Original-To`, or
`Envelope-To`. `To`/`Cc` is used only when exactly one address belongs to a
managed catch-all domain. Ambiguous messages are left in the control mailbox
and logged instead of guessing.

The catch-all route map is shared by all labeling and control behavior. Targets,
domains, and any exact-address copy forwards are supplied through
`RULES_TARGETS`, `RULES_ROUTES`, and `RULES_COPY_FORWARDS`; no deployment
addresses are embedded in the source. Accounts present only in the copy-forward
map are forward-only from the watcher's perspective: the original local copy
and recipient headers remain intact, while the configured destination receives
a copy through native Sieve `redirect :copy`.

The watcher uses a dedicated, Docker-network-restricted Stalwart account with
only impersonation plus the mailbox, email, blob and Sieve JMAP permissions it
needs. Its generated Sieve block is delimited by managed comments. It is the
single active Sieve script for each managed account and refuses to replace an
unexpected active script.

Every incoming message also keeps an `Autosorted/<destination-localpart>`
mailbox membership independently of Inbox, Archive, Junk, `Rules/*`, and
`Type/*`. The watcher follows native JMAP `Email/changes`; if an IMAP client
implements Archive or Move by replacing mailbox membership, the watcher adds
the destination label back without changing read state or any other mailbox.
The first run after enabling this invariant performs one complete reconciliation
of existing mail, then processes only changed messages.

Empty custom leaf mailboxes are removed through Stalwart's native
`Mailbox/changes`, polled hourly to avoid racing active IMAP COPY/MOVE
operations. The cleaner keeps a complete
parent map and fetches only changed mailbox objects after startup. Special-use
mailboxes, `Rules/*`, `Type/*`, and the managed `Autosorted` root are protected;
empty `Autosorted/*` children and other empty custom leaves are removed.

The watcher does not perform LLM classification. Existing `Type/*` mailboxes
and memberships are preserved; normal `Autosorted/*` and `Rules/*` processing
is unaffected.
