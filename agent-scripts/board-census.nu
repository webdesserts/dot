# Census of card workspaces: per-workspace change state, divergence, emptiness.
# Usage: nu board-census.nu [repo]   (default: ~/code/webdesserts/agent-task)
# Read-only. Parses `jj workspace list` + per-workspace `jj log` against trunk().
# NOTE: run `cd <ws>` before jj calls — -R into a secondary workspace does not
# resolve @ (its .jj is a workspace pointer, not a repo root).

def main [repo?: string] {
    let repo = ($repo | default $"($env.HOME)/code/webdesserts/agent-task")
    let ws_root = ($repo | path dirname | path join "ws")
    if not ($ws_root | path exists) { print $"no ws dir at ($ws_root)"; return }

    let listing = (cd $repo; jj workspace list | complete)
    if ($listing.stdout | is-empty) { print $"not a jj repo: ($repo)"; return }

    ls $ws_root | where type == dir | each {|d|
        let name = $d.name | path basename
        let line = ($listing.stdout | lines | where ($it | str starts-with $"($name):") | first | default "")
        cd $d.name
        let desc = (jj log -r @ --no-graph -T 'description' | complete | get stdout | str trim | str replace -a "\n" " " | str substring 0..60)
        let ahead = (jj log -r "main..@" --no-graph -T 'change_id.short() ++ "\n"' | complete | get stdout | lines | length)
        {
            workspace: $name
            modified: ($d.modified | format date "%m-%d %H:%M")
            ahead_of_main: (if ($line | str contains "(empty)") { 0 } else { $ahead })
            empty: ($line | str contains "(empty)")
            divergent: ($line | str contains "(divergent)")
            tip_desc: $desc
        }
    } | sort-by modified --reverse
}
