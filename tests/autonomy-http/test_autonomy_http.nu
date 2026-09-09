#!/usr/bin/env nu
# Tests for agent-scripts/autonomy-http.nu and agent-scripts/feedpost.nu
# (shared-http-helpers first slice).
#
# Boundaries honored here: DUMMY credentials only ("dummy-test-token"); the
# only network touched is a loopback fixture spawned below; no private shell
# startup is loaded when run as `nu --no-config-file tests/autonomy-http/
# test_autonomy_http.nu`; nothing is written outside this directory.
#
# Core checks (proportionate, per disposition): list success/empty/bad-shape,
# the exact large opaque revision STRING, stale-409 failure without retry,
# no legacy self-dismiss in feedpost, and authenticated posting identity.

use std/assert

# Hermeticity: a test run must never see ambient autonomy configuration
# (dummy credentials and the loopback fixture only). Hide any inherited env.
try { hide-env AUTONOMY_BASE } catch { }
try { hide-env AUTONOMY_TOKEN } catch { }

use ../../agent-scripts/autonomy-http.nu *
use ../../agent-scripts/feedpost.nu [ bare-keys, feed-post ]
use ../../agent-scripts/queue-watch.nu [ task-path ]

const DUMMY_TOKEN = "dummy-test-token"

# ---- pure: base-origin validation ------------------------------------------

print "OK: base origins — accept public https and loopback http"
assert equal (resolve-base --base "https://umbra.computer") "https://umbra.computer"
assert equal (resolve-base --base "https://umbra.computer/") "https://umbra.computer"
assert equal (resolve-base --base "http://127.0.0.1:4699") "http://127.0.0.1:4699"
assert equal (resolve-base --base "http://localhost:4699") "http://localhost:4699"
assert equal (resolve-base --base "http://[::1]:4699") "http://[::1]:4699"

print "OK: base origins — strict loopback allowlist (bounded-correction regressions)"
# Parent pure probe: the old '^127\.' prefix check ACCEPTED http://127.attacker.example.
# These must ALL be refused — look-alike 127.x hosts, suffix-attached localhost,
# bracket-suffix forms, and invalid ports:
for bad in [
    "http://127.attacker.example"
    "http://127.0.0.1.evil.com"
    "http://localhost.evil.com"
    "http://[::1]evil.example"
    "http://[::1]:0"
    "http://127.0.0.1:notaport"
] {
    try {
        resolve-base --base $bad
        error make {msg: $"TEST BUG: '($bad)' should have been refused"}
    } catch {|e|
        assert ($e.msg | str starts-with "REFUSED:") $"origin '($bad)' must be REFUSED"
    }
}

print "OK: base origins — no implicit localhost"
try {
    resolve-base
    error make {msg: "TEST BUG: resolve-base without origin should have refused"}
} catch {|e|
    assert ($e.msg | str contains "no base origin")
}

print "OK: base origins — refuse userinfo / query / fragment / path / non-loopback http / bad scheme"
for bad in [
    "http://user:pass@umbra.computer"
    "https://umbra.computer/api"
    "https://umbra.computer/?x=1"
    "https://umbra.computer#frag"
    "http://example.com"
    "ftp://umbra.computer"
    "umbra.computer"
] {
    try {
        resolve-base --base $bad
        error make {msg: $"TEST BUG: '($bad)' should have been refused"}
    } catch {|e|
        assert ($e.msg | str starts-with "REFUSED:") $"origin '($bad)' must be REFUSED"
    }
}

# ---- pure: credential resolution --------------------------------------------

let dir = ($env.FILE_PWD | default ".")
let kf = ($dir | path join "dummy-token.txt")
$DUMMY_TOKEN | save -f $kf

print "OK: credentials — key-file read, ambient override, refusal without leaking"
assert equal (resolve-credential --key-file $kf) $DUMMY_TOKEN
# documented precedence: explicit --key-file OVERRIDES ambient AUTONOMY_TOKEN
assert equal (with-env {AUTONOMY_TOKEN: "ambient-dummy"} { resolve-credential --key-file $kf }) $DUMMY_TOKEN
assert equal (with-env {AUTONOMY_TOKEN: "ambient-dummy"} { resolve-credential }) "ambient-dummy"
try { hide-env AUTONOMY_TOKEN } catch { }  # ensure NO ambient credential for this check
try {
    resolve-credential
    error make {msg: "TEST BUG: missing credential should have refused"}
} catch {|e|
    assert ($e.msg | str contains "REFUSED:")
}
let ws_kf = ($dir | path join "bad-token.txt")
"two tokens" | save -f $ws_kf
try {
    resolve-credential --key-file $ws_kf
    error make {msg: "TEST BUG: whitespace credential should have refused"}
} catch {|e|
    assert ($e.msg | str contains "REFUSED:")
    # the credential VALUE must never enter an error message
    assert (not ($e.msg | str contains "two tokens")) "token value leaked into error"
}

# ---- pure: list-response shape validation -----------------------------------

print "OK: list shape — success row preserved, revision stays an opaque STRING"
let good = {
    items: [{
        place: "feed:main"
        sender: "nir"
        text: "hello"
        resource_key: "feed:main.m:abc123"
        handle: "feed-post-abc123"
        revision: "98765432109876543210"  # exact large opaque decimal STRING
    }]
    retracted: 0
}
let good_out = (validate-list-response $good)
assert length $good_out.items 1
assert equal ($good_out.items | get 0.revision) "98765432109876543210"
assert (($good_out.items | get 0.revision | describe) == "string")
assert equal ($good_out.items | get 0.handle) "feed-post-abc123"
assert equal ($good_out.items | get 0.resource_key) "feed:main.m:abc123"

print "OK: list shape — a REAL empty items list is valid data"
let empty = (validate-list-response {items: [], retracted: 3})
assert length $empty.items 0
assert equal $empty.retracted 3

print "OK: list shape — missing items / non-object / numeric revision refused"
for bad in [
    {retracted: 0}                                            # missing items
    "login html"                                              # non-object body
    {items: [{place: "p", text: "t", handle: "h", revision: 98765432109876543210}], retracted: 0}
] {
    try {
        validate-list-response $bad
        error make {msg: "TEST BUG: bad shape should have been refused"}
    } catch {|e|
        assert ($e.msg | str contains "unexpected") "bad shape must be refused, got: ($e.msg)"
    }
}

# ---- pure: feedpost guards (unchanged behavior, network-free) ---------------

print "OK: feedpost guards — bare keys, HTML, malformed reply hash"
assert equal (bare-keys "see t:183 and autonomy/t:184") ["t:183"]
assert length (bare-keys "fine prose") 0
try {
    feed-post "hi <br> there" --base "http://127.0.0.1:1" --key-file $kf
    error make {msg: "TEST BUG: HTML guard should have fired"}
} catch {|e|
    assert ($e.msg | str starts-with "REFUSED: HTML tags")
}
try {
    feed-post "hi" --reply-to "BAD HASH" --base "http://127.0.0.1:1" --key-file $kf
    error make {msg: "TEST BUG: reply-hash guard should have fired"}
} catch {|e|
    assert ($e.msg | str starts-with "REFUSED: --reply-to")
}

print "OK: feedpost reply target — legacy/relative/wrong-shape forms refused LOCALLY (autonomy/t:268 absolute contract)"
# The candidate (5d7500aa) refuses legacy numeric / bare hash / m:-only /
# relative forms before lookup; the client refuses them locally so they never
# reach the wire. No legacy CLI shorthand is preserved.
for bad_reply in [
    "123"                      # legacy numeric id
    "0tkq1xnxs9"               # bare hash leaf
    "m:0tkq1xnxs9"             # m:-only key
    "feed:main.m:0tkq1xnxs9"   # relative (missing leading slash)
    "/feed:main.m:BAD"         # malformed hash leaf
] {
    try {
        feed-post "hi" --reply-to $bad_reply --base "http://127.0.0.1:1" --key-file $kf
        error make {msg: $"TEST BUG: reply-to '($bad_reply)' should have been refused"}
    } catch {|e|
        assert ($e.msg | str starts-with "REFUSED: --reply-to") $"reply-to '($bad_reply)' must be REFUSED"
    }
}

print "OK: no legacy self-echo dismissal remains in feedpost"
let fp_src = (open ($dir | path join ".." ".." "agent-scripts" "feedpost.nu"))
assert (not ($fp_src | str contains "notifications/dismiss")) "legacy self-dismiss must be gone"

# ---- fixture-backed: auth forwarding, redirects, shapes, stale 409 ----------

# Explicit env isolation for EVERY probe below (parent correction after a live
# dismiss was triggered by inherited configuration during review): re-hide any
# ambient autonomy env and re-assert it stays hidden, so no probe can fall back
# to ambient configuration; every network call uses the known loopback endpoint
# captured from the fixture ready-file, never an ambient AUTONOMY_BASE.
try { hide-env AUTONOMY_BASE } catch { }
try { hide-env AUTONOMY_TOKEN } catch { }
assert (not ("AUTONOMY_BASE" in $env))
assert (not ("AUTONOMY_TOKEN" in $env))

let ready = ($dir | path join "fixture.ready")
rm -f $ready
job spawn { ^python3 ($dir | path join "fixture_server.py") --port 0 --ready-file $ready }
mut tries = 0
while (not ($ready | path exists)) and $tries < 100 {
    sleep 50ms
    $tries += 1
}
assert ($ready | path exists) "fixture did not become ready"
let info = (open --raw $ready | str trim | split row " ")
let pid = ($info | get 0 | into int)
let base = $"http://127.0.0.1:($info | get 1)"

print "OK: fixture — bearer credential is actually forwarded (accepted verbatim)"
let who = (request-json "GET" "/whoami" --base $base --key-file $kf)
assert equal $who.user "fixture-agent"

print "OK: fixture — a WRONG credential is forwarded too (server answers 401, clearly)"
let bad_kf = ($dir | path join "wrong-token.txt")
"not-the-fixture-token" | save -f $bad_kf
try {
    request-json "GET" "/whoami" --base $base --key-file $bad_kf
    error make {msg: "TEST BUG: wrong credential should have failed"}
} catch {|e|
    assert ($e.msg | str contains "HTTP 401")
}

print "OK: fixture — redirects refused, never followed"
try {
    request-json "GET" "/redirect" --base $base --key-file $kf
    error make {msg: "TEST BUG: redirect should have been refused"}
} catch {|e|
    assert ($e.msg | str contains "redirect encountered")
}

print "OK: fixture — non-JSON 2xx body is a shape error, never data"
try {
    request-json "GET" "/html" --base $base --key-file $kf
    error make {msg: "TEST BUG: HTML body should have been refused"}
} catch {|e|
    assert ($e.msg | str contains "unexpected response shape")
}

print "OK: fixture — notification-list end-to-end, revision stays the exact STRING"
let listing = (notification-list --base $base --key-file $kf)
assert length $listing.items 1
assert equal ($listing.items | get 0.revision) "98765432109876543210"

print "OK: fixture — dismiss round-trips handle + revision verbatim"
let d = (notification-dismiss "feed-post-abc123" "12345" --base $base --key-file $kf)
assert equal $d.status "dismissed"
assert equal $d.revision "12345"  # echoed verbatim STRING, not a number

print "OK: fixture — stale revision is an HTTP 409 for caller reassessment, NO retry"
try {
    notification-dismiss "feed-post-abc123" "111" --base $base --key-file $kf
    error make {msg: "TEST BUG: stale revision should have raised 409"}
} catch {|e|
    assert ($e.msg | str contains "HTTP 409")
}

print "OK: dismiss — malformed revision refused client-side (leading zero / empty)"
try {
    notification-dismiss "feed-post-abc123" "0123" --base $base --key-file $kf
    error make {msg: "TEST BUG: leading-zero revision should have been refused"}
} catch {|e|
    assert ($e.msg | str starts-with "REFUSED:")
}
try {
    notification-dismiss "feed-post-abc123" "" --base $base --key-file $kf
    error make {msg: "TEST BUG: empty revision should have been refused"}
} catch {|e|
    assert ($e.msg | str starts-with "REFUSED:")
}

print "OK: feed-post — author from authenticated whoami; absolute owner-qualified reply sent UNCHANGED"
let posted = (feed-post "fixture post" --reply-to "/feed:main.m:0tkq1xnxs9" --base $base --key-file $kf)
assert equal $posted.author "fixture-agent"  # whoami identity, NOT a default "iris"
assert equal $posted.hash "abc123"  # reached the wire only because the ref was the exact absolute form (fixture enforces)

print "OK: feed-post — omitted reply_to is the distinct no-reply operation"
let top = (feed-post "top-level fixture post" --base $base --key-file $kf)
assert equal $top.hash "abc123"

print "OK: feed-post — wrong-owner ref refused LOCALLY, no HTTP (dead-port base proves no network)"
try {
    feed-post "fixture post" --reply-to "/feed:peri.nir.m:0tkq1xnxs9" --base "http://127.0.0.1:1" --key-file $kf
    error make {msg: "TEST BUG: wrong-owner reply should have been refused locally"}
} catch {|e|
    assert ($e.msg | str starts-with "REFUSED: --reply-to") "wrong-owner must be refused LOCALLY before any HTTP, got: ($e.msg)"
}

print "OK: feed-post — --author is a checked assertion against whoami, never impersonation"
try {
    feed-post "fixture post" --author "iris" --base $base --key-file $kf
    error make {msg: "TEST BUG: --author mismatch should have been refused"}
} catch {|e|
    assert ($e.msg | str contains "assertion, never impersonation")
}

# ---- queue-watch external-caller preparation (autonomy/t:268) ---------------

print "OK: queue-watch — canonical key encoded ONCE as ONE /tasks/ segment"
assert equal (task-path "autonomy/t:261") "/tasks/%2Fautonomy%2Ft%3A261"
assert equal (task-path "/autonomy/t:261") "/tasks/%2Fautonomy%2Ft%3A261"
assert (not (task-path "autonomy/t:261" | str contains "/t:")) "key must not survive partially encoded"

print "OK: queue-watch — task detail via shared bearer route (no UUID, no operator headers)"
let task = (request-json "GET" (task-path "autonomy/t:261") --base $base --key-file $kf)
assert equal $task.state "in_progress"
assert length $task.criteria 2
# the fixture 400s any X-Auth-User/X-Auth-Actor header and any multi-segment
# task path, so this success is the proof: bearer-only auth and the whole key
# URL-encoded once as a single segment

print "OK: queue-watch — same auth boundary on the /tasks route (wrong credential 401)"
try {
    request-json "GET" (task-path "autonomy/t:261") --base $base --key-file $bad_kf
    error make {msg: "TEST BUG: wrong credential on /tasks should have failed"}
} catch {|e|
    assert ($e.msg | str contains "HTTP 401")
}

print "OK: queue-watch — an UNENCODED key path is refused by the server (routing guard)"
try {
    request-json "GET" "/tasks/autonomy/t:261" --base $base --key-file $kf
    error make {msg: "TEST BUG: multi-segment task path should have been refused"}
} catch {|e|
    assert ($e.msg | str contains "HTTP 400")
}

# ---- cleanup (dummy-token files stay: they are fixture inputs, not secrets) --

# graceful fixture shutdown (no SIGTERM on the spawned job); kill as fallback
request-json "GET" "/shutdown" --base $base --key-file $kf | ignore
mut alive = true
mut waited = 0
while $alive and $waited < 40 {
    $alive = (^ps -p $pid | complete | get exit_code) == 0
    if $alive { sleep 100ms; $waited += 1 }
}
try { kill $pid } catch { }
# remove this run's scratch artifacts (all dummy values, nothing sensitive)
rm -f $kf $ws_kf $bad_kf $ready

print "ALL autonomy-http / feedpost checks passed"
