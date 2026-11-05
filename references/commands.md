# Commands and safe recovery

Use the Skill-local `scripts/ds-bot.ps1`. Every command supports `--json` and returns one JSON document. Wait progress is metadata on stderr. Timestamps are UTC; `observedAt` is the observation time.

| Command | Scope |
| --- | --- |
| `status`, `capabilities` | Installed version, readonly compatibility, loopback health, approved bridge readiness; no chat text |
| `bots`, `groups` | Actual existing team names, stable IDs and current sessions |
| `sessions [--bot <exact name-or-id>]` | Current and earlier session metadata |
| `resolve --bot <exact name-or-id>` | One exact target |
| `history --session <id> [--limit 30] [--before-seq <seq>] [--show-text]` | Only the explicitly selected Bot session; defaults to metadata |
| `send --dry-run --bot <id> --text <text> [--request-id <uuid-v4>]` | Full target/text preview; no send and no journal |
| `send --bot <id> --text <approved-text> --request-id <uuid> --expect-session <id> --approval-hash <sha256> [--wait --timeout 300 --show-text]` | One tracked send if the bridge is activated and the target/content were approved |
| `query --request-id <uuid> [--session <original-id>] [--show-text]` | Read only the request's journal-bound conversation |
| `wait --request-id <uuid> [--session <original-id>] [--timeout 300] [--show-text]` | Query/continue that reply, never send |

Names must be exact; ambiguous names fail. Retain stable IDs after resolving. No account/login flags exist: this targets one existing Windows DS Bot instance. Groups currently return `UNSUPPORTED_GROUP_HANDOFF` for send; an earlier session returns `SESSION_NOT_CURRENT`.

For multiline text, use a PowerShell here-string with `--text`. UTF-8 `--text-stdin` is available only with direct Node, since Windows PowerShell can recode stdin. Message limit is 64 KiB. Preview/actual send reject common credential patterns. Wait timeout is 0.001–3600 seconds (default 300); send timeout requires `--wait`. Wait can be resumed after it times out.

After the user approves a preview, reuse its values:

```powershell
# $Preview is the reviewed JSON preview, not an automatic approval.
& $DsBot send --bot $Preview.target.id --text $Preview.text `
  --request-id $Preview.requestId --expect-session $Preview.target.sessionId `
  --approval-hash $Preview.approvalHash --wait --timeout 300 --show-text --json

# Recovery always uses the original request; no message is sent here.
& $DsBot wait --request-id $Preview.requestId --timeout 300 --show-text --json
```

`summary.status` describes reply progress; `summary.transport` describes prompt acceptance. Inspect both. `reply_completed` proves a finished correlated reply turn, while `taskOutcome:not_verified` leaves business acceptance to the caller. Timeout does not mean failed delivery.

`SEND_UNCONFIRMED` retains the request ID. Query it; never retry with a fresh ID automatically. `ID_CONFLICT` means an existing ID binds different target/text. `INPUT_CHANGED`, `DUPLICATE_ANCHOR`, `CONCURRENT_USER_INPUT` and other conflicts require inspection. Do not clear journals to force sends.

`BRIDGE_PREFLIGHT_FAILED` is earlier than message submission: `phase:capabilities`, `sent:false`, `dispatchAttempted:false`, `deliveryState:not_dispatched`. Only one read-only readiness probe ran; no send intent was created. New sends allow up to 45 seconds for that probe, including native client startup, rather than the quick status probe's 5 seconds. Reply `--timeout` is a separate wait budget. Safe `probe` progress fields describe only the read-only capabilities frame, never a message submission. There is no reply to recover with `query`/`wait`. Once ready, the caller may explicitly continue the original, still-authorized send with the same request ID, exact text, approval hash and pinned current session. This is not an automatic retry and does not authorize changed content or a new message. A missing local receipt alone does not prove non-delivery for arbitrary failures; preserve and reconcile the original error and both receipt stores when diagnosing older versions.

`BRIDGE_NOT_CONFIGURED` means the current profile has no approved sender. `BRIDGE_NOT_RUNNING`/`BRIDGE_UNAVAILABLE` means it is stopped or not ready. `VERSION_UNVERIFIED`, source-pin mismatch, ACL validation failure and checksum errors require code/config review; they do not authorize repairing authentication or opening network access.
