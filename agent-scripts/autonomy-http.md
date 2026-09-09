# autonomy-http — shared HTTP/auth boundary for agent scripts

One native Nu implementation of the Autonomy gateway's JSON request/auth
boundary, shared by `agent-scripts/*.nu` (`feedpost.nu` already uses it).
Module: [`autonomy-http.nu`](autonomy-http.nu).

## Auth model (first slice: BEARER ONLY)

The base origin is the Caddy/auth-service **public boundary** (normally
`https://umbra.computer`). It accepts **bearer** credentials; this client
sends `Authorization: Bearer <token>` and nothing else.

- **Never** `X-Auth-User` / `X-Auth-Actor` from caller data. Those headers are
  stamped daemon-internally by the gateway; a client sending them is
  impersonating. They are not this client's auth mechanism.
- Token source: `AUTONOMY_TOKEN` from the caller's **private launcher**, or an
  explicit `--key-file <path>` holding just the token. **Precedence: an
  explicit `--key-file` OVERRIDES the ambient `AUTONOMY_TOKEN`** (so a caller
  can point at a new key file without touching its launcher).
- There is no `--token` value argument. Token values never enter argv, output,
  or error messages. Missing/empty/whitespace credentials fail with a clear
  `REFUSED:` error and never fall back to anything else.
- This bearer-only support is a documented compatibility limit of the first
  slice, **not** a claim that cookie auth is unnecessary. Cookie-only
  configuration fails clearly — no silent conversion, no login flow, no key
  rotation, no private-profile loading. A caller keeps using its existing own
  API key; no new identity is needed.

## Base origin (explicit, operator-trusted)

Pass `--base <origin>` or set `AUTONOMY_BASE`. **There is no implicit
localhost.** Validation refuses:

- userinfo (`user:pass@host`), query strings, fragments, and any base path —
  anything that could change request routing;
- plain `http` to anything but an exact, anchored local-fixture allowlist:
  `localhost`, `127.0.0.1`, or `[::1]`, plus a valid optional port (digits,
  1-65535). The match is strict parsed/anchored host validation with
  deliberately NO DNS lookup — a documented NARROWER allowance than the full
  set of loopback spellings (other `127.x.x.x` aliases, `0.0.0.0`); widen only
  via an explicit reviewed allowlist change. Look-alike and bracket-suffix
  hosts (`127.attacker.example`, `[::1]evil.example`, `localhost.evil.com`)
  are REFUSED, as are invalid ports;
- missing origins.

Redirects are **refused, never followed** (a redirect could re-route a request
away from the operator-trusted origin).

## Exported API

| command | purpose |
|---|---|
| `resolve-base --base <origin>` | validate + normalize the base origin |
| `resolve-credential --key-file <path>` | read the bearer token internally |
| `request-json <GET\|POST> <path> --base --key-file [--body <value>]` | the shared JSON request boundary |
| `notification-list [--place --group --before] ...` | validated `GET /notifications/list` |
| `notification-dismiss <handle> <revision> ...` | exact-revision `POST /notifications/dismiss-revision` |

`request-json` distinguishes, without ever dumping request headers or
credentials:

- **HTTP failure** — `HTTP <status> on <METHOD> <path> — <reason>. server
  message: <truncated public error text>`. A stale-revision `409` surfaces
  this way for caller reassessment; there is **no automatic retry**.
- **wrong shape / non-JSON** — a 2xx body that is not a JSON object/array
  (login HTML, empty body) is an error, never silently empty data.
- **transport failure** — connection-level problems.

## Notifications

- `notification-list` returns `{items: [...], retracted: <int>}`. It is **one
  paged view** (the server's `PAGE_SIZE` cap applies before collapse) — not a
  global total. There is no automatic pagination and no invented next cursor.
  Optional `--place` / `--group` / `--before` filters pass through safely and
  are only sent when non-empty. `sender` and `resource_key` may be null.
- **`revision` is an opaque decimal STRING** and stays a string through the
  whole round trip — never converted to a number (a numeric revision in a row
  is refused). A *real* empty `items` list is valid data; a *missing* `items`
  field or a login-HTML body is an error and must never read as an empty
  queue.
- `notification-dismiss <handle> <revision>` dismisses ONLY the explicitly
  supplied handle with the EXACT revision string a listing returned (echoed
  verbatim by the server). Malformed revisions (non-digits, leading zeros,
  empty) are refused client-side before any request. A stale revision is an
  `HTTP 409` error for the caller to re-list and reassess — no automatic retry
  with a newer token, no resource-level dedup, no ownership/presentation
  acknowledgment logic.

### Side-effect semantics (do not assume side-effect-free)

- For an **enrolled** recipient, `GET /notifications/list` **returns BEFORE
  any legacy auto-dismiss/drain side effects** — the enrolled path returns
  ahead of the legacy consuming work (per the server source,
  `prime/src/routes/notifications.rs` / `notification_tools.rs`).
- For an **unenrolled** caller, the server's list path still performs its
  auto-dismiss-on-render sweep and drains the retraction count. The endpoint
  is therefore NOT side-effect-free in all modes — do not adopt any
  opposite claim.

### Reply wire format (absolute owner-qualified — DEPLOYMENT PREREQUISITE)

Per autonomy/t:268 (Peri's feed-slice candidate `5d7500aa` in
`/Users/nir/code/worktrees/peri-t268-qualified`, reviewed read-only via
`git show`): `POST /feed`'s `reply_to` must be the ABSOLUTE owner-qualified
member reference **`/feed:main.m:<hash>`** (a JSON string). Omitted `reply_to`
keeps the distinct no-reply operation. The candidate refuses — BEFORE any
message lookup or write — legacy numeric ids, bare hashes, `m:`-only keys,
relative addresses, and well-formed refs addressing a different feed owner
(owner match through the same named-first/index-shorthand gate every feed
route uses).

This helper follows that contract:

- `--reply-to` accepts ONLY the canonical absolute main-feed form
  `/feed:main.m:<hash>` (hash leaf `[0-9a-z]{6,16}`), validated locally BEFORE
  any network call. No legacy CLI shorthand and no arbitrary-owner input — a
  deliberately narrow convenience client for this main-feed-only helper
  (wrong-owner, numeric, bare, `m:`-only, and relative inputs are refused
  locally, before any HTTP; the server still independently validates ownership
  on its side);
- **DEPLOYMENT PREREQUISITE: the candidate is NOT live yet.** Do not use
  `--reply-to` against the deployed gateway until the coordinated server
  rollout lands — the currently deployed resolver would refuse the absolute
  form. This gap is explicit and intentional, not accidental.

## feedpost migration

`feedpost.nu` now:

- posts through `request-json` (bearer auth; no `X-Auth-User` header);
- derives the author from the **authenticated `GET /whoami`** — no default
  `iris`, no identity headers trusted. The old `--author` flag remains ONLY as
  a checked assertion against whoami (a mismatch REFUSES; it is never
  impersonation);
- normalizes `--reply-to` to the absolute owner-qualified main-feed member form
  — the caller supplies `/feed:main.m:<hash>` explicitly and the client sends
  it UNCHANGED after local structural validation (autonomy/t:268 feed slice,
  Peri's candidate `5d7500aa`; see Reply wire format below);
- keeps the citation (`bare-keys`), HTML-tag, and reply-hash guards unchanged;
- **no longer performs the legacy self-echo dismissal** — server self-echo
  suppression owns that; the post-then-dismiss dance is gone.

## queue-watch migration (external callers, autonomy/t:268)

`queue-watch.nu` now fetches each card through the shared bearer boundary
instead of UUID + operator-header + implicit localhost:

- usage: `nu queue-watch.nu --base <origin> [--key-file <path>]` (or
  AUTONOMY_BASE / the caller's ambient AUTONOMY_TOKEN from its private
  launcher — same bearer contract as above);
- each card's CANONICAL key from the FIXED inventory (unchanged) is sent as
  ONE URL-encoded path segment: `GET /tasks/<whole-key-encoded-once>` — e.g.
  `/tasks/%2Fautonomy%2Ft%3A261` (make the inventory key absolute first, then apply `url encode -a` once). The internal
  UUID is NEVER sent on HTTP;
- the UUID-based `shadow-check` FILESYSTEM lookup (criteria-shadow-census.nu,
  read-only TOML) is legitimate internal use and stays UUID-based — it is not
  an address and not part of the HTTP contract;
- output columns unchanged.

Known stale signal, noted honestly and NOT repaired here (separate task):
shadow-census' ratification warning logic predates the AlreadyRatified ledger
state, so already-ratified draft/tip divergence can still be flagged.

## Tests

`nu --no-config-file tests/autonomy-http/test_autonomy_http.nu`

Dummy credentials only (`dummy-test-token`), loopback fixture only
(`fixture_server.py`, spawned and shut down by the test itself), no private
shell startup loaded, no live Autonomy writes. `--no-config-file` is
important: it keeps ambient/private shell config out of the test environment
(the test additionally hides any inherited `AUTONOMY_*` env at start AND again
before the fixture-backed section, asserts the env stays hidden, and points
every probe at the known loopback endpoint captured from the fixture
ready-file — never at an ambient origin). Pure regression cases cover the
strict loopback allowlist (`127.attacker.example`, bracket-suffix
`[::1]evil.example`, etc.).

## Known limits

- GET/POST only (that is all the current callers need).
- Cookie/session auth is out of scope for this slice (see Auth model).
- No automatic pagination of `/notifications/list` — deliberate.
- The absolute reply wire format depends on Peri's UNDEPLOYED candidate
  `5d7500aa` — deployment prerequisite above; main-feed only (no generic
  resolver, no named/tag-scoped feeds, no new pagination features).
- No Dot.toml/link installation: public-repo module imports suffice.
