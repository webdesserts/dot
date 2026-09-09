# Queue-watch: live state of Michael's working queue (the six cards on his board).
# Usage:
#   nu queue-watch.nu --base https://umbra.computer [--key-file <path>]
#   (or AUTONOMY_BASE / AUTONOMY_TOKEN from the caller's private launcher)
# Read-only: detail route per card + criteria-shadow-census shadow-check.
#
# HTTP contract (autonomy/t:268 external-caller preparation): each card's
# CANONICAL task key from the fixed inventory below is sent as ONE URL-encoded
# path segment — GET /tasks/<whole-key-encoded-once> (e.g.
# /tasks/%2Fautonomy%2Ft%3A261) — through the shared bearer-auth boundary
# (autonomy-http.nu): explicit operator-trusted --base (or AUTONOMY_BASE; no
# implicit localhost), the caller's OWN bearer credential (--key-file or the
# ambient AUTONOMY_TOKEN from its launcher). The internal UUID is NEVER sent
# on HTTP (it is not the address); the UUID-based shadow-check FILESYSTEM
# lookup below is legitimate internal use and stays.
#
# Known stale signal (noted honestly, NOT repaired here — out of scope):
# shadow-census' ratification warning logic predates the AlreadyRatified
# ledger state, so a card whose draft/tip divergence is already ratified
# history can still be flagged; repairing that module is a separate task.

use autonomy-http.nu *
use criteria-shadow-census.nu shadow-check

const QUEUE = [
    {key: "autonomy/t:261", uuid: "01a06900-9762-77f0-b0bf-5e72b4016aae", ws: "peri-t261"}
    {key: "autonomy/t:263", uuid: "01a06932-e450-7e30-ad34-a921069de035", ws: "peri-t263"}
    {key: "autonomy/t:259", uuid: "01a068dd-6f48-73b2-9f95-84f478ddba5f", ws: "t:259 plan on disk"}
    {key: "autonomy/t:260", uuid: "01a068f9-98b8-7710-94c4-d9cbad5bbfde", ws: "-"}
    {key: "autonomy/t:264", uuid: "01a06945-2dcd-7932-937f-d489632e6a4a", ws: "-"}
    {key: "autonomy/t:266", uuid: "01a06996-fd76-7d80-a877-38d37df8db97", ws: "-"}
]

# Whole canonical key encoded ONCE as ONE /tasks/ path segment
# (server contract: GET /tasks/{key_or_id} — the key must arrive decoded to
# the single selector; a literal "/" inside the key would change routing).
export def task-path [key: string] {
  let absolute = if ($key | str starts-with "/") { $key } else { $"/($key)" }
  $"/tasks/($absolute | url encode -a)"
}

def main [
  --base: string = ""      # operator-trusted origin (or AUTONOMY_BASE); no implicit localhost
  --key-file: string = ""  # bearer credential file; overrides ambient AUTONOMY_TOKEN
] {
    let rows = ($QUEUE | each {|card|
        let t = (request-json "GET" (task-path $card.key) --base $base --key-file $key_file)
        let shadow = (shadow-check $card.uuid)
        {
            key: $card.key
            state: $t.state
            criteria: ($t.criteria | length)
            shadow: (if ($shadow | is-empty) { "clean" } else { $shadow | get 0.damage })
            workspace: $card.ws
            title: ($t.title | str substring 0..45)
        }
    })
    $rows
}
