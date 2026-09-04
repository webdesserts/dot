# Queue-watch: live state of Michael's working queue (the six cards on his board).
# Usage: nu queue-watch.nu
# Read-only: detail route per card + criteria-shadow-census shadow-check.

use ../agent-scripts/criteria-shadow-census.nu *

const QUEUE = [
    {key: "autonomy/t:261", uuid: "01a06900-9762-77f0-b0bf-5e72b4016aae", ws: "peri-t261"}
    {key: "autonomy/t:263", uuid: "01a06932-e450-7e30-ad34-a921069de035", ws: "peri-t263"}
    {key: "autonomy/t:259", uuid: "01a068dd-6f48-73b2-9f95-84f478ddba5f", ws: "t:259 plan on disk"}
    {key: "autonomy/t:260", uuid: "01a068f9-98b8-7710-94c4-d9cbad5bbfde", ws: "-"}
    {key: "autonomy/t:264", uuid: "01a06945-2dcd-7932-937f-d489632e6a4a", ws: "-"}
    {key: "autonomy/t:266", uuid: "01a06996-fd76-7d80-a877-38d37df8db97", ws: "-"}
]

def main [] {
    let rows = ($QUEUE | each {|card|
        let t = (http get -H {X-Auth-User: iris} $"http://127.0.0.1:4600/tasks/($card.uuid)")
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
