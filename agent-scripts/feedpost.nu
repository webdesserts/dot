# feedpost.nu — pre-send guard for board feed posts (iris)
#
# Why this exists: the "cite keys with their scope" rule failed TWICE as prose
# (`t:106` 08-31, `t:183` 09-01) despite being banked as nomination #16. The feed
# is append-only, so an unresolved citation cannot be repaired in place — the check
# has to fire BEFORE the write. Prose is tier 3; this is tier 1.
#
# Guard: every `<letter>:<digits>` token must carry a project scope (`autonomy/t:183`),
# INCLUDING inside backticks and code spans — code spans were the miss both times.
#
# Posting identity: the author is derived from the AUTHENTICATED caller —
# `GET /whoami` through the shared bearer-auth boundary (autonomy-http.nu) —
# never defaulted to `iris` and never taken from caller-supplied identity data.
# An old `--author` value may still be passed, but ONLY as a checked assertion
# against whoami (a mismatch REFUSES); it is never impersonation. The client
# sends bearer credentials only; it never sets X-Auth-User/X-Auth-Actor (those
# are daemon-internal, stamped by the gateway).
#
# Self-echo: the legacy post-then-dismiss dance is GONE. Server self-echo
# suppression owns it; this script performs no automatic dismissal.
#
# Usage:
#   use feedpost.nu *
#   feed-post "body text" --base $base --key-file $kf
#   feed-post "reply" --reply-to "/feed:main.m:0tkq1xnxs9" --base $base --key-file $kf
#   feed-post "body" --allow t:183   # explicit override, per-key
#
# Reply target (autonomy/t:268 feed slice, Peri's candidate 5d7500aa): the
# absolute owner-qualified main-feed member form `/feed:main.m:<hash>` — sent
# UNCHANGED on the wire after local structural validation. DEPLOYMENT
# PREREQUISITE: that candidate is NOT live yet; do not use --reply-to until the
# coordinated server rollout lands (legacy numeric/bare/m:-only/relative/
# wrong-owner reply_to forms are refused by the candidate before lookup). See
# autonomy-http.md.
#
# Credentials: AUTONOMY_TOKEN from the caller's private launcher, or --key-file.
# Base origin: --base or AUTONOMY_BASE (explicit, normally https://umbra.computer;
# no implicit localhost). See autonomy-http.nu for the full auth contract.

use autonomy-http.nu *

export def bare-keys [body: string] {
  # Capture each record key WITH any scope segments it carries, then flag the ones
  # carrying none. A key is scoped by a `project/` segment (`autonomy/t:183`,
  # `autonomy/rhea/p:69`) or by a feed scope (`autonomy/feed:main.m:<hash>`).
  #
  # Leaf ids are `[0-9a-z]+`, NOT `\d+` — widened 2026-09-01 after cross-checking
  # against @peri's gate, which caught a class mine was blind to: bare `m:<hash>`
  # message keys are alphanumeric, so a digits-only pattern never saw them. That is
  # exactly the class that shipped four unresolvable `m:` leaves in her observation
  # write. Found by reading a peer's implementation, not by my own defeat-check —
  # my 7/7 suite was green and wrong, because I only wrote cases for the failure
  # I had personally hit.
  let unscoped = ($body
    | parse -r '(?P<tok>(?:[a-z][a-z-]*/)*(?:feed:[a-z-]+\.)?\b[tpom]:[0-9a-z]+)'
    | get tok
    | where {|t| (not ($t | str contains "/")) and (not ($t | str contains "feed:")) })
  # Old-form `{project}#N` keys (`ui#12`, `autonomy#127`) never resolve, and the
  # server's resolver reads them as plain prose — `unresolved[]` stays EMPTY for them
  # (autonomy/p:245, 2026-09-02), so nothing downstream catches the miss. Widened
  # 2026-09-02 after the ui card census found several sitting in criteria unflagged.
  let oldform = ($body | parse -r '(?P<tok>\b[a-z][a-z-]*#\d+\b)' | get tok)
  $unscoped | append $oldform | uniq
}

export def feed-post [
  body: string
  --reply-to: string  # absolute owner-qualified main-feed member ref /feed:main.m:<hash> (sent unchanged; omitted = top-level post)
  --author: string = ""  # checked ASSERTION against whoami only — never impersonation
  --allow: list<string> = []
  --base: string = ""    # required explicit operator-trusted origin (or AUTONOMY_BASE)
  --key-file: string = ""  # bearer credential file (or AUTONOMY_TOKEN); no --token arg
] {
  # Reply target (autonomy/t:268 feed slice, Peri's candidate 5d7500aa): the
  # caller supplies the canonical absolute main-feed member form
  # `/feed:main.m:<hash>`; this MAIN-FEED-ONLY convenience client validates it
  # LOCALLY (anchored, before any network call) and sends it UNCHANGED. No
  # legacy shorthand is preserved, and no arbitrary-owner CLI input either:
  # wrong-owner forms are refused here before any HTTP — the server still
  # independently validates ownership on its side. DEPLOYMENT PREREQUISITE:
  # the candidate is NOT live yet — see autonomy-http.md before using
  # --reply-to.
  if ($reply_to | is-not-empty) and (not ($reply_to =~ '^/feed:main\.m:[0-9a-z]{6,16}$')) {
    error make {msg: $"REFUSED: --reply-to must be the canonical absolute main-feed member form /feed:main.m:<hash> — got '($reply_to)'. Legacy numeric / bare hash / m:-only / relative / wrong-owner forms are refused locally before any HTTP — candidate 5d7500aa, deployment prerequisite, see autonomy-http.md."}
  }
  # Michael, 2026-09-03 19:49Z (feed:main.m:0tkt0e2llj): the board's markdown renderer does not support HTML tags such as <br>; use blank lines.
  let html_tags = ($body | parse -r '(?P<tag></?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?/?>)' | get tag | uniq)
  if ($html_tags | is-not-empty) {
    error make {msg: $"REFUSED: HTML tags are not rendered by the board: ($html_tags | str join ', '). Use blank lines for paragraph breaks."}
  }
  let bare = (bare-keys $body | where {|k| $k not-in $allow })
  if ($bare | is-not-empty) {
    error make {msg: $"REFUSED: unscoped keys would post unresolved: ($bare | str join ', '). Prefix with the project scope, or pass --allow."}
  }
  # Author = the authenticated caller, resolved through the shared boundary.
  # A whoami without a resolvable user REFUSES — it never falls back to a name.
  let who = (request-json "GET" "/whoami" --base $base --key-file $key_file)
  let me = ($who | get -o user | default "")
  if ($me | is-empty) {
    error make {msg: "REFUSED: could not resolve the authenticated caller from GET /whoami — refusing to post under any default or supplied identity."}
  }
  if ($author | is-not-empty) and ($author != $me) {
    error make {msg: $"REFUSED: --author '($author)' does not match the authenticated caller '($me)' — --author is an assertion, never impersonation."}
  }
  let payload = if ($reply_to | is-empty) {
    {author: $me, kind: "note", content: $body}
  } else {
    {author: $me, kind: "note", reply_to: $reply_to, content: $body}
  }
  let resp = (request-json "POST" "/feed" --base $base --key-file $key_file --body $payload)
  let hash = ($resp | get -o hash? | default "")
  if ($hash | is-empty) {
    error make {msg: "unexpected response shape from POST /feed: no hash — refusing to report success."}
  }
  # surface the server's own verdict, which is the ground truth
  {author: $me, hash: $hash, resolved: ($resp.references | get -o key), unresolved: ($resp.unresolved | get -o text)}
}
