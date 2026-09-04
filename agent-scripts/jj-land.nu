# jj-land.nu — land a commit chain on LOCAL main with guards. NEVER pushes.
#
#   nu ~/.claude/scripts/jj-land.nu <TIP_SHA> <EXPECTED_MAIN_SHA> <EXPECTED_COUNT> [--repo <path>]
#
# Replaces the per-card landing scripts (t234-land.nu and friends), which lived in the
# scratchpad and evaporated with it.
#
# WHY THE ANCESTOR GUARD EXISTS (2026-09-03, Iris's find, adopted after verifying my own
# script had the identical hole): a guard of the shape "`main..<tip>` has exactly N commits"
# reads like a base check but is really a size check. That range yields N entries whether or
# not main is an ancestor of the tip, so a chain built on a STALE base passes it cleanly.
# Iris's web commit was five commits behind main and her guard said fine; what actually
# stopped it was jj independently refusing the bookmark move as "backwards or sideways" —
# i.e. the guard was decorative and the safety came from somewhere else entirely.
# `main & ::<tip>` returning main is the real assertion: main is genuinely an ancestor.
def main [
  tip: string,
  expected_main: string,
  expected_count: int,
  --repo: string = "/Users/nir/code/webdesserts/agent-task"
] {
  let jj = {|args| ^jj -R $repo --ignore-working-copy ...$args | complete }

  # 1. main is where we think it is (another lane may have landed under us)
  let main_now = (do $jj [log --no-graph -r main -T 'commit_id.short(12)'] | get stdout | str trim)
  if not ($main_now | str starts-with $expected_main) and not ($expected_main | str starts-with $main_now) {
    error make {msg: $"GUARD: main is ($main_now), expected ($expected_main) — another lane landed. STOP."}
  }

  # 2. there is something to land
  let tip_full = (do $jj [log --no-graph -r $tip -T 'commit_id.short(12)'] | get stdout | str trim)
  if $tip_full == $main_now {
    error make {msg: "GUARD: tip IS main — nothing to land."}
  }

  # 3. THE ANCESTOR GUARD — main must be a true ancestor of the tip, not merely N behind it.
  #    Without this, a chain rebased off a stale base lands a silently wrong tree.
  let anc = (do $jj [log --no-graph -r $"main & ::($tip)" -T 'commit_id.short(12)'] | get stdout | str trim)
  if ($anc | is-empty) {
    error make {msg: $"GUARD: main ($main_now) is NOT an ancestor of ($tip) — divergent base. Rebase onto main first. STOP."}
  }

  # 4. the chain is the size we expect, and clean
  let chain = (do $jj [log --no-graph -r $"main..($tip)" -T 'commit_id.short(8) ++ " " ++ if(conflict, "(CONFLICT) ", "") ++ description.first_line() ++ "\n"'] | get stdout | lines | where {|l| ($l | str trim) != "" })
  if ($chain | length) != $expected_count {
    error make {msg: $"GUARD: expected ($expected_count) commits over main, got ($chain | length): ($chain)"}
  }
  if ($chain | any {|l| $l =~ 'CONFLICT'}) {
    error make {msg: $"GUARD: conflict marker in the chain: ($chain)"}
  }

  # 5. no Claude trailers — standing rule, commits are human-authored
  let trailers = (do $jj [log --no-graph -r $"main..($tip)" -T 'description'] | get stdout | lines | where {|l| $l =~ 'Co-Authored|Claude-Session|Generated with' })
  if ($trailers | length) > 0 {
    error make {msg: $"GUARD: trailer lines present: ($trailers)"}
  }

  # 6. move the bookmark (local only — this script never pushes)
  let set = (do $jj [bookmark set main -r $tip])
  let main_after = (do $jj [log --no-graph -r main -T 'commit_id.short(12)'] | get stdout | str trim)

  {
    chain_landed: $chain,
    ancestor_ok: $anc,
    bookmark_set_exit: $set.exit_code,
    bookmark_set_err: ($set.stderr | str substring 0..300),
    main_before: $main_now,
    main_after: $main_after,
    ok: ($main_after == $tip_full)
  }
}
