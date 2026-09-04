# criteria-shadow-census.nu — read-only census of draft-vs-tip criteria divergence
#
# WHY: CriterionStore::ratify re-emits draft.toml, which stops being updated at a card
# FIRST ratification (autonomy/o:719; re-emission at criterion_store.rs:346). Every
# post-ratification criteria write lands as a vN.toml snapshot only. So a ratify — and
# the approval click IS the ratify path — silently reverts the tip back to the draft.
#
# BOTH DIRECTIONS MATTER. A deletion-only census has FALSE NEGATIVES, not merely a low
# count: a card whose draft holds ids the tip lacks is reported clean while a ratify
# would still corrupt it. Measured 2026-09-03: deletion-only saw 26 cards / 84 criteria;
# both directions saw 28 cards / 107 (84 deletions + 23 resurrections), and TWO cards
# (019fdc65, 019fc663) were resurrection-only — invisible to the deletion-only method.
#
# Tip selection verified at source: latest_version_locked read_dirs the task dir and
# takes max of the parsed v{N} numbers, so the highest-numbered vN.toml IS the tip.
#
# READ-ONLY AND DB-FREE: pure TOML reads, opens no TaskStore, so it cannot trip
# autonomy/o:665 (an out-of-process TaskStore open unlinks the daemon sqlite sidecars).
# Safe with the daemon up, which is what makes it usable as a window pre-check.
#
# TIMESTAMPED MEASUREMENT, NOT A PROPERTY — it moves whenever anyone edits criteria.
# Re-run rather than cite an old number.
#
# Usage:
#   use ~/.claude/scripts/criteria-shadow-census.nu *
#   shadow-census              # at-risk targets, worst first
#   shadow-census --all        # include clean targets
#   shadow-check <uuid>        # one target, verdict included
#   shadow-totals              # the headline numbers

export def targets-root [] { $env.HOME | path join ".local/share/autonomy/registry/targets" }

# Criterion ids in one criteria TOML. Anchored so that task_id never matches.
export def crit-ids [path: string] {
  if not ($path | path exists) { return [] }
  open --raw $path | lines
    | where {|l| ($l | str starts-with "id = ") }
    | each {|l| $l | str replace -r "^id = \\"(.*)\\"$" "$1" }
    | uniq
}

export def shadow-census [--all] {
  ls (targets-root) | where type == dir | each {|d|
    let draft = ($d.name | path join "draft.toml")
    let vs = (ls $d.name | where {|f| (($f.name | path basename) | str replace -r "^v\\d+\\.toml$" "MATCH") == "MATCH" })
    if (($vs | length) == 0) or (not ($draft | path exists)) { null } else {
      let topn = ($vs | each {|f| $f.name | path basename | str replace -r "^v(\\d+)\\.toml$" "$1" | into int } | math max)
      let dids = (crit-ids $draft)
      let tids = (crit-ids ($d.name | path join $"v($topn).toml"))
      let del = ($tids | where {|i| $i not-in $dids })
      let res = ($dids | where {|i| $i not-in $tids })
      let dmg = (($del | length) + ($res | length))
      if ($dmg == 0) and (not $all) { null } else {
        { uuid: ($d.name | path basename), tipv: $topn,
          del: ($del | length), res: ($res | length), damage: $dmg,
          verdict: (if $dmg == 0 { "TRULY SAFE" } else { "AT RISK" }),
          del_ids: ($del | str join ","), res_ids: ($res | str join ",") }
      }
    }
  } | compact | sort-by damage del --reverse
}

export def shadow-check [uuid: string] { shadow-census --all | where uuid == $uuid }

export def shadow-totals [] {
  let r = (shadow-census)
  { cards_at_risk: ($r | length),
    deletions: ($r | get del | math sum),
    resurrections: ($r | get res | math sum),
    total_criteria: ($r | get damage | math sum),
    resurrection_only: ($r | where {|x| ($x.del == 0) and ($x.res > 0) } | get uuid) }
}
