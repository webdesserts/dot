#!/usr/bin/env nu
# fireworks-usage.nu — Umbra's metered-API spend, read from the primed daemon log.
#
# primed logs one `llm response received` line per ego round with prompt_tokens,
# completion_tokens (and cached_tokens when the provider reports them) and the
# model entry name from ~/.config/autonomy/models.toml. This prices those rounds
# for the remote entries (Fireworks today; the OpenCode Go plan was flat-rate and
# is listed at $0 so its rounds still show up) and reports per model, per day,
# and against a budget. Zero model tokens spent: the log in, tables out.
# Companion to token-census.nu, which covers the Anthropic side (Claude Code
# sessions); this one covers Umbra's seat.
#
# Usage:
#   fireworks-usage.nu                         # since local midnight today
#   fireworks-usage.nu --since 2026-09-03      # since a date (local midnight)
#   fireworks-usage.nu --since 2026-09-03T01:15:00Z
#   fireworks-usage.nu --budget 100            # remaining against a USD budget (default 100)
#   fireworks-usage.nu --json                  # one record instead of tables
#   fireworks-usage.nu --log                   # also append the one-line summary to
#                                              # ~/.claude/logs/fireworks-usage/usage.log
#
# Two cost columns, because the log may not carry cache hits: `cost_max` prices
# every prompt token at the uncached rate; `cost_est` credits logged cached_tokens
# at the cached rate. The Fireworks dashboard is the invoice; this is the running
# estimate between dashboard checks.

# USD per million tokens, Fireworks serverless Standard tier
# (docs.fireworks.ai/serverless/pricing, read 2026-09-03). Keyed by the
# models.toml entry NAME, which is what primed logs as `model=`. Edit here when
# prices move or entries are added; unknown names fall back to `default`.
const PRICES = {
  "fireworks-glm-5.3-flash": {input: 0.15, cached: 0.03, output: 0.50},
  "opencode-glm-5.2":        {input: 0.0,  cached: 0.0,  output: 0.0},
  "default":                 {input: 0.15, cached: 0.03, output: 0.50},
}

const LOG = "/Users/nir/Library/Logs/webdesserts-primed/primed.log"

def price-for [model: string] {
  if ($model in ($PRICES | columns)) { $PRICES | get $model } else { $PRICES.default }
}

# One `llm response received` line -> a round record, or null when the round ran
# on a local model (qwen/gemma) and costs nothing.
def parse-round [line: string] {
  let model = ($line | parse -r 'provider_chat\{model=(?P<m>[^ }]+)' | get m.0? | default '')
  if ($model == '') or ($model =~ '^qwen|^gemma') { return null }
  {
    ts: ($line | parse -r '^(?P<ts>\S+)' | get ts.0 | into datetime),
    model: $model,
    prompt: ($line | parse -r 'prompt_tokens=(?P<n>\d+)' | get n.0? | default '0' | into int),
    completion: ($line | parse -r 'completion_tokens=(?P<n>\d+)' | get n.0? | default '0' | into int),
    cached: ($line | parse -r 'cached_tokens=(?P<n>\d+)' | get n.0? | default '0' | into int),
    latency_ms: ($line | parse -r 'latency_ms=(?P<n>\d+)' | get n.0? | default '0' | into int),
    finish: ($line | parse -r 'finish_reason=(?P<f>\w+)' | get f.0? | default ''),
  }
}

def summarize [rows: list] {
  let n = ($rows | length)
  if $n == 0 {
    return {rounds: 0, prompt: 0, completion: 0, cached: 0, cost_max: 0.0, cost_est: 0.0, avg_prompt: 0, avg_latency_ms: 0}
  }
  let p = ($rows | get prompt | math sum)
  let c = ($rows | get completion | math sum)
  let k = ($rows | get cached | math sum)
  let priced = ($rows | each {|r|
    let pr = (price-for $r.model)
    {
      max: ((($r.prompt * $pr.input) + ($r.completion * $pr.output)) / 1000000),
      est: (((($r.prompt - $r.cached) * $pr.input) + ($r.cached * $pr.cached) + ($r.completion * $pr.output)) / 1000000),
    }
  })
  {
    rounds: $n, prompt: $p, completion: $c, cached: $k,
    cost_max: ($priced | get max | math sum | math round --precision 4),
    cost_est: ($priced | get est | math sum | math round --precision 4),
    avg_prompt: (($p / $n) | math round),
    avg_latency_ms: ($rows | get latency_ms | math avg | math round),
  }
}

def main [
  --since: string          # ISO date or datetime; default = local midnight today
  --budget: float = 100.0  # USD budget to report remaining against
  --json                   # emit one record instead of tables
  --log                    # append the one-line summary to ~/.claude/logs/fireworks-usage/usage.log
  --logfile: string = $LOG # override the daemon log path
] {
  let since_dt = (if ($since | is-empty) {
    date now | format date '%Y-%m-%dT00:00:00%z' | into datetime
  } else {
    $since | into datetime
  })
  let rows = (open --raw $logfile | lines
    | where {|l| $l =~ 'llm response received' }
    | each {|l| parse-round $l }
    | compact
    | where ts >= $since_dt)
  let total = (summarize $rows)
  let per_model = ($rows | group-by model | transpose model items
    | each {|g| {model: $g.model} | merge (summarize $g.items) })
  let per_day = ($rows | group-by {|r| $r.ts | format date '%Y-%m-%d' } | transpose day items
    | each {|g| {day: $g.day} | merge (summarize $g.items) })
  let remaining = (($budget - $total.cost_est) | math round --precision 2)
  let stamp = (date now | format date '%Y-%m-%dT%H:%M:%S%z')
  let since_s = ($since_dt | format date '%Y-%m-%dT%H:%M:%S%z')
  let summary_line = $"($stamp) since=($since_s) rounds=($total.rounds) prompt=($total.prompt) completion=($total.completion) cached=($total.cached) cost_est=($total.cost_est) cost_max=($total.cost_max) budget=($budget) remaining_est=($remaining)"
  if $log {
    let dir = ($env.HOME | path join '.claude/logs/fireworks-usage')
    mkdir $dir
    $summary_line + "\n" | save --append ($dir | path join 'usage.log')
  }
  let record = {
    since: $since_dt, total: $total, budget_usd: $budget, remaining_est_usd: $remaining,
    per_model: $per_model, per_day: $per_day,
  }
  if $json { return ($record | to json) }
  print $"Umbra metered rounds since ($since_s): ($total.rounds)  |  est $($total.cost_est) \(max $($total.cost_max)\)  |  budget $($budget) -> remaining ~ $($remaining)"
  if ($per_model | is-not-empty) { print "\nPer model:"; print ($per_model | table) }
  if ($per_day | is-not-empty) { print "\nPer day:"; print ($per_day | table) }
  if $total.rounds == 0 { print "(no metered rounds in range: Umbra is on a local model, or the flip has not happened yet)" }
}
