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
# Usage:
#   use feedpost.nu *
#   feed-post "body text" --reply-to $hash
#   feed-post "body" --reply-to $hash --allow t:183   # explicit override, per-key

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
  --reply-to: string
  --author: string = "iris"
  --allow: list<string> = []
  --base: string = "http://127.0.0.1:4600"
] {
  # `... | last 1 | get hash` yields a one-element LIST; nushell stringifies it at the
  # flag boundary ("[0tkq...]") so a type check can't see it, and the server answers
  # 422 with no hint (bit us 2026-09-02). Validate the hash FORMAT instead.
  if ($reply_to | is-not-empty) and (not ($reply_to =~ '^[0-9a-z]{6,16}$')) {
    error make {msg: $"REFUSED: --reply-to must be a bare feed hash like 0tkq1xnxs9, got '($reply_to)' — use `last` not `last 1`."}
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
  let payload = if ($reply_to | is-empty) {
    {author: $author, kind: "note", content: $body}
  } else {
    {author: $author, kind: "note", reply_to: $reply_to, content: $body}
  }
  let resp = (http post -t application/json -H ["X-Auth-User" $author] $"($base)/feed" $payload)
  # Self-echo cleanup (interim until t:267's write-side suppression lands): the
  # daemon queues our own post as a persistent notification to us — the poster
  # always knows the resulting handle, so dismiss it immediately. Without this,
  # every own post re-offers on every poll and wakes the agent (2026-09-04).
  let echo_handle = $"feed-post-($resp.hash)"
  do -i { http post -t application/json -H ["X-Auth-User" $author] $"($base)/notifications/dismiss" {handle: $echo_handle} } | ignore
  # surface the server's own verdict, which is the ground truth
  {hash: $resp.hash, resolved: ($resp.references | get -i key), unresolved: ($resp.unresolved | get -i text)}
}