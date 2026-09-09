# autonomy-http.nu — shared JSON request/auth boundary for autonomy callers
#
# One native Nu HTTP implementation, shared by every agent-script that talks
# to the Autonomy gateway. First-slice scope (parent disposition, shared
# HTTP-helpers effort):
#
# - BEARER-ONLY auth. The intended base origin is the Caddy/auth-service
#   public boundary (normally https://umbra.computer), which accepts bearer
#   credentials. This is a documented compatibility limit, not a claim that
#   cookie auth is unnecessary. Cookie-only configuration fails CLEARLY —
#   it is never silently "converted" into anything else.
# - NEVER sets X-Auth-User / X-Auth-Actor from caller data. Those headers
#   are stamped daemon-internally by the gateway; a client that sends them
#   is impersonating. This module only ever sends `Authorization: Bearer`.
# - Explicit operator-trusted base origin REQUIRED (`--base` flag or
#   AUTONOMY_BASE). No implicit localhost. Plain http is accepted ONLY for an
#   exact, anchored local-fixture allowlist: localhost, 127.0.0.1, [::1], with
#   a valid optional port (no DNS lookup — a deliberately narrow allowance).
# - Credentials are read internally: ambient AUTONOMY_TOKEN, or an explicit
#   --key-file path (which OVERRIDES the ambient token). There is no
#   --token value argument; values never enter argv, output, or error
#   messages. No private profiles are sourced, no auto-login, no rotation.
# - Redirects are REFUSED, never followed (a redirect could re-route a
#   request to a different origin than the operator trusted).
# - Failures are classified: HTTP status failure (status + reason + the
#   server's own public error text, truncated — never request headers or
#   credentials), wrong-shape/non-JSON response, or transport failure.
#
# Usage:
#   use autonomy-http.nu *
#   request-json "GET" "/whoami" --base https://umbra.computer
#   request-json "POST" "/feed" --base $base --key-file $kf --body {author: "iris", kind: "note", content: "..."}
#   notification-list --base $base
#   notification-dismiss "feed-post-abc123" "98765432109876543210" --base $base

# Valid optional port (as captured WITH its leading ':'): digits only, 1-65535.
def valid-port [port: string] {
  if not ($port =~ '^:[0-9]+$') { return false }
  let n = ($port | str substring 1.. | into int)
  $n >= 1 and $n <= 65535
}

# Exact, anchored loopback-host match for plain-http fixtures. Accepts ONLY:
#   localhost[:port] | 127.0.0.1[:port] | [::1][:port]
# Anything else — including 127.attacker.example, localhost.evil.com, and
# bracket-suffix forms like [::1]evil.example — is refused (anchor: the WHOLE
# host string must be one allowlist entry plus at most a :digits port).
def loopback-allowed [host_port: string] {
  if ($host_port | str starts-with "[") {
    # bracketed IPv6: the whole string must be [addr] with at most a :port suffix
    let mb = ($host_port | parse -r '^\[(?P<addr>[^\]]+)\](?P<port>:\d+)?$')
    let addr_ok = if ($mb | is-empty) { false } else { ($mb | get 0.addr) == "::1" }
    let port = ($mb | get -o 0.port | default "")
    $addr_ok and (($port | is-empty) or (valid-port $port))
  } else {
    let mh = ($host_port | parse -r '^(?P<addr>[^:\[]+)(?P<port>:\d+)?$')
    let addr_ok = if ($mh | is-empty) { false } else { ($mh | get 0.addr) in ["localhost" "127.0.0.1"] }
    let port = ($mh | get -o 0.port | default "")
    $addr_ok and (($port | is-empty) or (valid-port $port))
  }
}

# Resolve and VALIDATE the base origin. Returns the origin WITHOUT a trailing
# slash, suitable for string-joining with a "/..." path.
#
# Refused (all REFUSED: errors, never warnings): missing origin, non-http(s)
# scheme, userinfo (`user:pass@host` — could change request routing),
# query/fragment, any base path beyond `/`, and plain http to anything but the
# exact local-fixture allowlist (localhost / 127.0.0.1 / [::1], optional valid
# port) — the allowlist exists solely for local test fixtures. Look-alike and
# bracket-suffix hosts (127.attacker.example, [::1]evil.example) are refused.
export def resolve-base [
  --base: string = ""  # operator-trusted origin; falls back to $env.AUTONOMY_BASE
] {
  let raw = if ($base | is-not-empty) {
    $base
  } else {
    $env.AUTONOMY_BASE? | default ""
  }
  if ($raw | is-empty) {
    error make {msg: "REFUSED: no base origin — pass --base or set AUTONOMY_BASE. An explicit operator-trusted origin is required; no implicit localhost."}
  }
  let m = ($raw | parse -r '^(?P<scheme>https?):\/\/(?P<host>[^\/@?#]+)(?P<rest>\/.*)?$')
  if ($m | is-empty) {
    error make {msg: "REFUSED: base origin must be a bare http(s) origin like https://umbra.computer — no userinfo, no query, no fragment, no base path (any of those could change request routing)."}
  }
  let parsed = ($m | get 0)
  if ($parsed.scheme == "http") {
    # STRICT loopback allowlist (bounded-correction parent probe: the previous
    # '^127\.' prefix check accepted look-alike hosts such as 127.attacker.example,
    # and an unanchored bracket parse accepted [::1]evil.example). Plain http is
    # allowed ONLY for an exact, anchored match against a minimal explicit fixture
    # allowlist — localhost, 127.0.0.1, [::1] — plus a valid optional port
    # (digits, 1-65535). Deliberately NO DNS lookup: this documents a NARROWER
    # allowance than the full set of loopback spellings (e.g. other 127.x.x.x
    # aliases, 0.0.0.0) — widen only via an explicit reviewed allowlist change.
    if not (loopback-allowed ($parsed.host | str lowercase)) {
      error make {msg: "REFUSED: plain http is only for the explicit local-fixture allowlist — exactly localhost, 127.0.0.1, or [::1], with a valid optional port. Use the public https origin for anything else."}
    }
  }
  let rest = ($parsed.rest? | default "")
  if ($rest != "") and ($rest != "/") {
    error make {msg: $"REFUSED: base origin must not carry a path — got '($rest)'. A base path could change request routing; put the full path in each request instead."}
  }
  $"($parsed.scheme)://($parsed.host)"
}

# Resolve the bearer credential. Precedence: an explicit --key-file OVERRIDES
# the ambient AUTONOMY_TOKEN (documented; a caller can point at a rotated key
# file without unsetting its launcher env). The token is returned for use as
# a header value ONLY — it must never be printed, echoed, or included in an
# error message. There is deliberately no --token value argument.
export def resolve-credential [
  --key-file: string = ""  # path to a file holding just the token; overrides ambient env
] {
  let token = if ($key_file | is-not-empty) {
    open --raw $key_file | str trim
  } else {
    $env.AUTONOMY_TOKEN? | default "" | str trim
  }
  if ($token | is-empty) {
    error make {msg: "REFUSED: no bearer credential — set AUTONOMY_TOKEN in the caller's private launcher or pass --key-file. Cookie-only configuration is not supported by this client (bearer-only first slice); it fails here rather than falling back to anything else."}
  }
  # A token is an Authorization header value: single line, no whitespace or
  # control characters inside. Refuse (without echoing it) rather than send a
  # malformed header.
  if ($token =~ '[\s\x00-\x1f]') {
    error make {msg: "REFUSED: bearer credential contains whitespace or control characters and cannot be a valid Authorization header value. Check the token source (value not shown)."}
  }
  $token
}

def classify-failure [
  err: record
  method: string
  path: string
] {
  let rendered = ($err.rendered? | default "")
  if ($rendered | str contains "Redirect encountered") {
    error make {msg: $"REFUSED: redirect encountered on ($method) ($path) — this client refuses redirects instead of following them, a redirect could re-route the request away from the operator-trusted origin. Re-check the base origin."}
  }
  # In current Nu the catch parameter is a wrapper record: the useful text
  # lives in .rendered and .details — .raw holds the error itself and can't
  # be piped anywhere.
  let detail = ($err.details? | default {})
  let inner = ($detail.msg? | default ($err.msg? | default ""))
  let m = ($inner | parse -r 'HTTP Error (?P<status>\d+) \((?P<reason>[^)]*)\)')
  if ($m | is-not-empty) {
    let status = ($m | get 0.status | into int)
    # The server's own PUBLIC error text is useful and carries no credential;
    # request headers and the bearer token are never included. Truncate hard.
    let server_text = ($detail.labels? | default [] | get -o text | default [] | str join " " | str substring 0..200)
    error make {msg: $"HTTP ($status) on ($method) ($path) — ($m | get 0.reason). server message: $server_text"}
  }
  error make {msg: $"transport failure on ($method) ($path): ($inner)"}
}

# The shared JSON request boundary. Sends one bearer-authenticated request to
# `path` on the validated base origin and returns the parsed JSON body.
#
# Raises (never returns success after a refused mutation):
#   - "REFUSED: ..."   — bad base origin, bad path, missing/invalid credential
#   - "HTTP <status> ..." — any non-2xx response (including 409 stale, which
#     callers may catch for reassessment — no automatic retry happens here)
#   - "unexpected response shape" — 2xx whose body is not JSON (HTML login
#     pages, empty bodies, bare strings) — never surfaced as an empty result
#   - "transport failure ..." — connection/DNS-level problems
export def request-json [
  method: string        # "GET" or "POST"
  path: string          # begins with "/", e.g. "/notifications/list"
  --base: string = ""   # operator-trusted origin (see resolve-base)
  --key-file: string = ""  # bearer credential file (see resolve-credential)
  --body: any = null    # JSON-serializable value, required for POST
] {
  let origin = (resolve-base --base $base)
  let token = (resolve-credential --key-file $key_file)
  if not ($path | str starts-with "/") {
    error make {msg: $"REFUSED: request path must start with '/' — got '($path)'. The base origin carries the scheme/host, requests carry the path."}
  }
  let url = $"($origin)($path)"
  let headers = {Authorization: $"Bearer ($token)"}
  let method_uc = ($method | str uppercase)
  let resp = if $method_uc == "GET" {
    try {
      http get -R error -H $headers $url
    } catch {|err| classify-failure $err $method_uc $path }
  } else if $method_uc == "POST" {
    if ($body == null) {
      error make {msg: "REFUSED: POST requires a --body value."}
    }
    try {
      http post -R error -H $headers -t application/json $url $body
    } catch {|err| classify-failure $err $method_uc $path }
  } else {
    error make {msg: $"REFUSED: unsupported method '($method)' — this boundary speaks GET and POST."}
  }
  # 2xx but not JSON (login HTML, empty body, bare string): wrong shape, not
  # data. A string response must never masquerade as an empty queue/result.
  let kind = ($resp | describe)
  if (not ($kind | str starts-with "record")) and (not ($kind | str starts-with "table")) and (not ($kind | str starts-with "list")) {
    error make {msg: $"unexpected response shape on ($method_uc) ($path): got ($kind) where JSON object/array was required — a login page or non-JSON body? Refusing to interpret it as data."}
  }
  $resp
}

# GET /notifications/list — one paged view of the caller's live notifications
# (newest first, server PAGE_SIZE cap before collapse). This is NOT a global
# total and there is deliberately no automatic pagination or invented cursor.
#
# Optional pass-through filters: --place / --group / --before (before is the
# server's numeric event-id window bound). Each is only sent when non-empty.
#
# Row validation (never silently loosened): items must be a list of records
# with string place/text/handle, an OPAQUE DECIMAL STRING revision (a numeric
# revision is refused — no numeric conversion, ever), and nullable
# sender/resource_key. handle/revision/resource metadata are preserved
# verbatim for dismissal round-trips.
export def notification-list [
  --base: string = ""
  --key-file: string = ""
  --place: string = ""
  --group: string = ""
  --before: int = -1  # negative = omit
] {
  let q = ({})
  let q = if ($place | is-not-empty) { $q | insert place $place } else { $q }
  let q = if ($group | is-not-empty) { $q | insert group $group } else { $q }
  let q = if $before >= 0 { $q | insert before $before } else { $q }
  let qs = if ($q | is-empty) { "" } else { $"?($q | url build-query)" }
  let resp = (request-json "GET" $"/notifications/list($qs)" --base $base --key-file $key_file)
  validate-list-response $resp
}

# Row/response validation for GET /notifications/list — exported pure so tests
# can exercise shape refusals without a network call. Never silently loosened:
# items must be a list of records with string place/text/handle, an OPAQUE
# DECIMAL STRING revision (a numeric revision is refused — no numeric
# conversion, ever), and nullable sender/resource_key. handle/revision/resource
# metadata are preserved verbatim for dismissal round-trips. A REAL empty
# items list is valid data; a MISSING items field or a login-HTML body is an
# error — it must never read as an empty queue.
export def validate-list-response [resp: any] {
  if (not ($resp | describe | str starts-with "record")) {
    error make {msg: "unexpected response shape from /notifications/list: not a JSON object (a login page or non-JSON body?) — refusing to report an empty queue."}
  }
  let cols = ($resp | columns)
  if (not ($cols | any {|c| $c == "items"})) or (not ($cols | any {|c| $c == "retracted"})) {
    error make {msg: "unexpected response shape from /notifications/list: record without items/retracted — refusing to report an empty queue from a malformed body."}
  }
  if (not ($resp.items | describe | str starts-with "list")) and (not ($resp.items | describe | str starts-with "table")) {
    error make {msg: "unexpected response shape from /notifications/list: items is not a list — refusing to report an empty queue from a malformed body."}
  }
  mut out_items = []
  for it in $resp.items {
    $out_items = ($out_items | append (validate-list-row $it))
  }
  # retracted must be a number (drain count), nothing else
  if (not ($resp.retracted | describe | str starts-with "int")) {
    error make {msg: "unexpected response shape from /notifications/list: 'retracted' is not a number — refusing to guess."}
  }
  {items: $out_items, retracted: $resp.retracted}
}

def validate-list-row [it: any] {
  let kind = ($it | describe)
  if (not ($kind | str starts-with "record")) {
    error make {msg: $"unexpected row shape in /notifications/list items: got ($kind), expected a record — refusing to guess."}
  }
  for field in [place text handle] {
    let v = ($it | get -o $field | default "")
    if (not ($v | describe | str starts-with "string")) or ($v | is-empty) {
      error make {msg: $"unexpected row shape in /notifications/list: '($field)' must be a nonempty string — refusing to guess."}
    }
  }
  let rev = ($it | get -o revision)
  if (not ($rev | describe | str starts-with "string")) or (not ($rev =~ '^[0-9]+$')) {
    error make {msg: "unexpected row shape in /notifications/list: 'revision' must be an opaque decimal STRING (never converted to a number) — refusing to guess."}
  }
  for field in [sender resource_key] {
    let v = ($it | get -o $field)
    let vk = ($v | describe)
    if ($v != null) and (not ($vk | str starts-with "string")) {
      error make {msg: $"unexpected row shape in /notifications/list: '($field)' must be a string or absent/null — got ($vk). Refusing to guess."}
    }
  }
  $it
}

# POST /notifications/dismiss-revision — dismiss ONE explicitly supplied
# handle + the EXACT revision string a listing returned. No list-and-sweep,
# no batching, no resource-level dedup, no ownership/acknowledgment logic.
#
# Stale revisions surface as an "HTTP 409" error for CALLER reassessment —
# this command performs NO automatic retry with a newer token. The revision
# is echoed by the server verbatim; it is never computed from or converted to
# a number on the way through.
export def notification-dismiss [
  handle: string    # the exact handle a listing returned
  revision: string  # the exact opaque decimal-string revision a listing returned
  --base: string = ""
  --key-file: string = ""
] {
  if ($handle | is-empty) {
    error make {msg: "REFUSED: dismiss needs an explicitly supplied handle — nothing was given."}
  }
  # Client-side mirror of the server's own canonical-decimal check (reject
  # empty/non-digit/leading-zero) so a malformed token is refused locally
  # before any request. The value is still sent VERBATIM when valid.
  if not ($revision =~ '^[0-9]+$') or (($revision | str length) > 1 and ($revision | str starts-with "0")) {
    error make {msg: "REFUSED: revision must be the exact decimal-string token a notification listing returned (no sign, no whitespace, no leading zero) — it is never computed or rounded."}
  }
  let resp = (request-json "POST" "/notifications/dismiss-revision" --base $base --key-file $key_file --body {handle: $handle, revision: $revision})
  if (not ($resp.status? | default "" | str starts-with "dismissed")) and ($resp.status? | default "" != "already-handled") {
    error make {msg: $"unexpected response shape from /notifications/dismiss-revision: status '($resp.status? | default '')' — refusing to report success."}
  }
  $resp
}
