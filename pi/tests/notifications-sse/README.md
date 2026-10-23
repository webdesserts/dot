# Presentation receipt / recovery checks

The worker's only ACK authority is a qualifying **complete on-disk custom_message**, not a send return, model run, socket event, digest metadata alone or local cursor. Presentation IDs from SSE `id:` are not resume authority. The supervisor's one-outstanding guard is transient; a validated ACK outcome releases it. This suite uses owned files/loopback daemons and synthetic credentials only.

## Bounded archive reader

`notifications.sse.protocol.mjs::readQualifyingReceipts` retains its synchronous result/caller contract. It opens one regular-file FD, snapshots its initial size, then reads at most that many bytes in 64 KiB chunks. Total archive size is not limited by Node's single-string ceiling. Only the unfinished record is buffered; each complete LF record is decoded as strict UTF8 and parsed as a JSON object with a nonempty string `type` before classification. Ignored records are still checked for that framing/basic shape; this is not a full validator for every SDK entry-specific schema. A UTF8 BOM remains in decoded text: BOM-prefixed JSON is refused, while a BOM-only whitespace line remains ignorable as before.

The first complete nonblank object must be the matching session header; a second header refuses the entire pass. A partial final record cannot qualify, even if its JSON is otherwise complete. Appends beyond the initial snapshot wait for the next reconciliation. Malformed complete JSON/UTF8/non-object records, IO/close errors, observed truncation, pathname/inode replacement or same-size metadata mutation discard **all** collected results, including an otherwise qualifying prefix.

The final FD/path checks use exact bigint device/inode and nanosecond metadata; byte positions are separately required to be safe numeric integers. They detect observable races; they are not a lock or atomic transaction with a writer/HTTP ACK. A truncate-and-regrow or in-place mutation combined with append may evade metadata-only detection, and mutation after return remains possible. Session files are expected to be ordinary SDK append-only archives. Scan work is O(snapshot bytes), with no persistent cursor/cache; very large/slow scans can still block the worker's event loop.

Two explicit **provisional availability bounds** prevent replacing the original failure with unbounded buffering/results:

- **64 MiB per record, excluding LF**, including an unfinished tail.
- **100,000 presentation candidates**, qualifying or refused, per snapshot. Refusal reasons and retained presentation IDs are bounded/static/typed so result payloads do not defeat this count bound.

Exceeding either refuses the entire pass with an actionable diagnostic; it never skips records, prunes an archive or authorizes a partial ACK batch. The parent independently measured Iris's current archive at roughly 548 MB, max complete record 1,229,271 bytes, 2,640 candidates, one actual header and no malformed/partial records. Those metadata observations fit the bounds but **are not receipt qualification or ACK authority**, nor a guarantee about future files. Changing limits requires reviewing actual record/memory evidence, not deleting data or rotating a session as a workaround.

Existing body/hash, session, scope, handle AND validated stable actor-ID binding, schema/render version, safe numeric identity and part-reference gates remain. Legacy missing part references still normalize to null; null and zero remain distinct. Malformed/composite header placement is deliberately tightened to the native SDK header-first format.

## Executed consumer coverage

- `large-reader.test.mjs` streams an owned archive beyond 537 MB and `buffer.constants.MAX_STRING_LENGTH`, without constructing an archive-sized JS string. An isolated process confirms the original whole-UTF8 primitive throws ERR_STRING_TOO_LONG; another invokes the real reader with a 256 MiB JS heap allowance. It reports byte size and peak RSS. This memory assertion concerns flat 64 KiB-record archives; a record near the 64 MiB safety cap has a larger bounded parsing working set.
- `reader-boundaries.test.mjs` covers LF/UTF8 chunk edges, incomplete tails, append snapshots, exact record/count limits, malformed data after good evidence, BOM behavior, late/duplicate headers, short reads, injected IO/close errors and detected truncate/replacement/mutation. Mutation probes touch only uniquely owned files and restore the Node FS test hooks.
- The large-history case in `worker.test.mjs` uses the real worker and 2,640 fully qualifying owned receipts. It exposes the **existing historical ACK amplification**: every reconciliation serially visits old receipts again, even when the server returns already_acknowledged. The fixture demonstrates old-offer retirement and fresh delivery/receipt ACK, not low-latency progress under arbitrary history/remote outage conditions. An uncertain historical ACK can stop a batch before current work. No ACK-priority, cursor, durable suppression or cache policy is added here.
- `sdk-recovery.test.mjs` uses selected **Pi 1.4.0**, actual notification supervisor/worker, a file-backed SessionManager, native custom-message persistence and a credential-free faux model. An old SDK-produced receipt in a >537 MB file retires its offer; a newer offer wakes exactly one model run, produces exact LF-framed disk evidence and is acknowledged. The manager is created before adding owned archive padding, modeling an already-running SDK; this does not qualify cold SDK startup parsing of an oversized archive.

The existing protocol/worker/supervisor cases retain identity, replay, bounded retry, child-exclusion and one-outstanding checks. Native H2/redirect/TLS tests remain separate transport evidence.

## Commands and known baseline distinction

Use the selected installed SDK for the real consumer:

```nu
with-env {PI_SDK_ROOT: '/Users/michael/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent'} {
  node --test --test-reporter=tap ...(glob pi/tests/notifications-sse/*.test.mjs)
}
```

Pre-change baseline had two transport fixture timeouts: redirect/TLS cases expect a visible failure wake within 8 seconds, but inherit the production **90-second escalation window**. A hypothesis-specific diagnostic using existing `AUTONOMY_SSE_ESCALATE_AFTER_MS=0` passes both while retaining real TLS verification and redirect-destination no-contact assertions. That is cadence-qualified diagnostic evidence, not a claim that default-cadence baseline tests pass. No TLS trust, production transport, escalation policy or fixture assertion was weakened by this repair.

Source/test changes do not activate a live worker. Parent-owned review, deployment and coordinated replacement of loaded code are separate; preserve the real actor/session/scope binding and let only actual qualifying disk bytes authorize ACKs. Do not manually advance a cursor or acknowledge Iris's rows to simulate recovery. Compaction does not shrink the raw archive and is not receipt-reader recovery evidence.
