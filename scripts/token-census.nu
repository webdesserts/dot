#!/usr/bin/env nu
# token-census.nu — Claude Code token usage (and estimated cost) from the local transcripts.
#
# Reads every ~/.claude/projects/**/*.jsonl modified since --since, keeps assistant
# messages, de-duplicates by API request id (streamed content blocks repeat the same
# usage), and reports per model → aggregated (plus per lane and per day):
#   requests · total tokens · non-cache input · cache write · cache read · output ·
#   cache-hit % (cache reads / all input) · cache-miss % (non-cache in + cache writes / all input) ·
#   estimated cost in USD; --tools gives per-tool call counts + estimated tokens through each tool.
# Zero model tokens spent — plain files in, tables out.
#
# Usage:
#   token-census.nu                      # last 7 days
#   token-census.nu --since 2026-08-11   # since a date (local midnight)
#   token-census.nu --json               # machine-readable record instead of tables
#   token-census.nu --log                # also append the one-line summary to
#                                        # ~/.claude/logs/token-census/census.log
#
# Only sessions on THIS machine are counted (laptop sessions are not here), and the
# local model (llama-swap / Umbra) costs no Anthropic tokens, so it never appears.

# List prices, USD per million tokens (Anthropic, Aug 2026). Cache reads = 10% of input;
# cache writes = 1.25× input (5-minute) or 2× input (1-hour). Unknown models fall back to
# the `default` row and are flagged in the output. Edit here when prices move.
const PRICES = {
  "claude-fable-5":  {input: 10.0, output: 50.0},
  "claude-opus-5":   {input: 5.0,  output: 25.0},
  "claude-sonnet-5": {input: 2.0,  output: 10.0},
  "claude-haiku-4-5": {input: 1.0, output: 5.0},
  "claude-opus-4":   {input: 15.0, output: 75.0},
  "claude-sonnet-4": {input: 3.0,  output: 15.0},
  "default":         {input: 3.0,  output: 15.0},
}

# Session directory → who runs there (umbra). Edit as lanes change.
const LANE_LABELS = {
  "webdesserts": "peri (agent-task lane)",
  "ui": "iris (ui lane)",
  "notes": "nightly notetaker",
  "obsidian-memory": "obsidian-memory sessions",
}

def price-for [model: string] {
  let hit = ($PRICES | columns | where { |k| $k != "default" and ($model | str starts-with $k) } | first)
  if $hit == null { {row: $PRICES.default, known: false} } else { {row: ($PRICES | get $hit), known: true} }
}


# --tools: how often each tool is called and roughly how many tokens flow through it
# (tool inputs are output tokens spent calling; tool results are input tokens fed back).
# Transcripts carry no per-block token counts, so this uses chars/4 as the estimate.
def tool-census [files: list<string>, since_iso: string] {
  # 1) tool_use blocks (assistant side): id → name, input size
  let uses = ($files | each { |f|
    let raw = (do { rg --no-filename '"type":"tool_use"' $f } | complete | get stdout)
    if ($raw | is-empty) { [] } else {
      $raw | lines | each { |l|
        let m = (try { $l | from json } catch { null })
        if $m == null or ($m | get -o timestamp | default "") < $since_iso or ($m | get -o type) != "assistant" { [] } else {
          ($m.message.content | default [] | where { |b| ($b | get -o type) == "tool_use" } | each { |b|
            {id: ($b | get -o id), name: ($b | get -o name | default "?"), in_chars: (($b | get -o input | default {} | to json) | str length)}
          })
        }
      } | flatten
    }
  } | flatten | uniq-by id)
  let names = ($uses | reduce -f {} { |u, acc| $acc | insert $u.id $u.name })
  # 2) tool_result blocks (user side): tool_use_id → result size
  let results = ($files | each { |f|
    let raw = (do { rg --no-filename '"type":"tool_result"' $f } | complete | get stdout)
    if ($raw | is-empty) { [] } else {
      $raw | lines | each { |l|
        let m = (try { $l | from json } catch { null })
        if $m == null or ($m | get -o timestamp | default "") < $since_iso { [] } else {
          let content = ($m | get -o message.content | default [])
          if ($content | describe) == "string" { [] } else {
            $content | where { |b| ($b | get -o type) == "tool_result" } | each { |b|
              {id: ($b | get -o tool_use_id), out_chars: (($b | get -o content | default "" | to json) | str length)}
            }
          }
        }
      } | flatten
    }
  } | flatten | uniq-by id)
  let res_by_id = ($results | reduce -f {} { |r, acc| $acc | insert $r.id $r.out_chars })
  let joined = ($uses | each { |u| {name: $u.name, in_chars: $u.in_chars, out_chars: ($res_by_id | get -o $u.id | default 0)} })
  let total_chars = (($joined | get in_chars | math sum) + ($joined | get out_chars | math sum))
  $joined | group-by name | transpose tool rows | each { |g|
    let inc = ($g.rows | get in_chars | math sum); let outc = ($g.rows | get out_chars | math sum)
    {tool: $g.tool, calls: ($g.rows | length), est_call_tokens_k: ($inc / 4 / 1e3 | math round --precision 1), est_result_tokens_k: ($outc / 4 / 1e3 | math round --precision 1), est_total_tokens_k: (($inc + $outc) / 4 / 1e3 | math round --precision 1), share_pct: (if $total_chars == 0 { 0 } else { (($inc + $outc) / $total_chars * 100) | math round --precision 1 }), avg_result_tokens: (if ($g.rows | length) == 0 { 0 } else { ($outc / 4 / ($g.rows | length)) | math round })}
  } | sort-by est_total_tokens_k -r
}

def main [
  --since: string = ""    # ISO date (local); default = 7 days ago
  --json                  # print one record instead of tables
  --log                   # append a one-line summary to the census log
  --tools                 # per-tool call counts + estimated tokens through each tool (chars/4)
] {
  let since_dt = (if $since == "" { (date now) - 7day } else { $since | into datetime })
  let since_iso = ($since_dt | date to-timezone utc | format date "%Y-%m-%dT%H:%M:%SZ")
  let root = ("~/.claude/projects" | path expand)

  # Files touched since the cutoff (mtime is a cheap pre-filter; the timestamp filter below is the real one).
  let files = (glob $"($root)/**/*.jsonl" | where { |f| (ls $f | get 0.modified) > $since_dt })

  if $tools {
    let t = (tool-census $files $since_iso)
    if $json { return ($t | to json) }
    print $"Tool census since ($since_iso | str substring 0..9) — estimated from tool input/result sizes \(chars/4\); results are the input tokens fed back \(then cached\), calls the output tokens spent"
    print ($t | table); return
  }

  # One row per assistant API message. rg pre-filters lines so nu only parses what matters.
  let rows = (
    $files
    | each { |f|
        let raw = (do { rg --no-filename '"type":"assistant"' $f } | complete | get stdout)
        if ($raw | is-empty) { [] } else {
          $raw | lines | each { |l|
            let m = (try { $l | from json } catch { null })
            if $m == null or ($m | get -o message.usage) == null { null } else {
              let u = $m.message.usage
              let cw_total = ($u | get -o cache_creation_input_tokens | default 0)
              let cw_1h = ($u | get -o cache_creation.ephemeral_1h_input_tokens | default 0)
              let cw_5m = ($u | get -o cache_creation.ephemeral_5m_input_tokens | default ($cw_total - $cw_1h))
              {
                rid: ($m | get -o requestId | default ($m | get -o message.id | default $m.uuid)),
                ts: ($m | get -o timestamp | default ""),
                model: ($m | get -o message.model | default "?"),
                lane: (let b = (($m | get -o cwd | default "?") | path basename); $LANE_LABELS | get -o $b | default $b),
                input: ($u | get -o input_tokens | default 0),
                cw_5m: $cw_5m,
                cw_1h: $cw_1h,
                cache_read: ($u | get -o cache_read_input_tokens | default 0),
                output: ($u | get -o output_tokens | default 0),
              }
            }
          } | compact
        }
      }
    | flatten
    | where model != "<synthetic>" and ts >= $since_iso
    | uniq-by rid
  )

  # Cost per row from its own model's price row.
  let priced = ($rows | each { |r|
    let p = (price-for $r.model)
    let per_m = $p.row
    let cost = (($r.input * $per_m.input) + ($r.cw_5m * $per_m.input * 1.25) + ($r.cw_1h * $per_m.input * 2.0) + ($r.cache_read * $per_m.input * 0.10) + ($r.output * $per_m.output)) / 1e6
    $r | insert cost $cost | insert price_known $p.known
  })

  let sum = { |t|
      let input = ($t | get input | math sum); let cw = (($t | get cw_5m | math sum) + ($t | get cw_1h | math sum))
      let cr = ($t | get cache_read | math sum); let out = ($t | get output | math sum)
      let all_in = ($input + $cw + $cr)
      {
        requests: ($t | length),
        total_M: (($all_in + $out) / 1e6 | math round --precision 1),
        non_cache_in_M: ($input / 1e6 | math round --precision 2),
        cache_write_M: ($cw / 1e6 | math round --precision 2),
        cache_read_M: ($cr / 1e6 | math round --precision 1),
        out_M: ($out / 1e6 | math round --precision 2),
        cache_hit_pct: (if $all_in == 0 { 0 } else { ($cr / $all_in * 100) | math round --precision 1 }),
        cache_miss_pct: (if $all_in == 0 { 0 } else { (($input + $cw) / $all_in * 100) | math round --precision 1 }),
        est_cost_usd: ($t | get cost | math sum | math round --precision 2),
      }
  }

  let totals = (do $sum $priced)
  let by_model = ($priced | group-by model | transpose model rows | each { |g| {model: $g.model, price_known: ($g.rows | get price_known | all { |b| $b })} | merge (do $sum $g.rows) } | sort-by est_cost_usd -r)
  let by_lane = ($priced | group-by lane | transpose lane rows | each { |g| {lane: $g.lane} | merge (do $sum $g.rows) } | sort-by est_cost_usd -r)
  let by_day = ($priced | insert day { |r| $r.ts | str substring 0..9 } | group-by day | transpose day rows | each { |g| {day: $g.day} | merge (do $sum $g.rows) } | sort-by day)
  let unknown_models = ($by_model | where price_known == false | get model)

  let summary_line = $"($since_iso | str substring 0..9)..(date now | format date '%Y-%m-%d') · requests ($totals.requests) · total ($totals.total_M) M · est $($totals.est_cost_usd) · cache-hit ($totals.cache_hit_pct)% / miss ($totals.cache_miss_pct)% · non-cache in ($totals.non_cache_in_M) M · cache-write ($totals.cache_write_M) M · cache-read ($totals.cache_read_M) M · out ($totals.out_M) M"

  if $log {
    let dir = ("~/.claude/logs/token-census" | path expand)
    mkdir $dir
    $"(date now | format date '%Y-%m-%dT%H:%M:%S%z') ($summary_line)\n" | save --append $"($dir)/census.log"
    {generated: (date now | format date "%Y-%m-%dT%H:%M:%S%z"), since: $since_iso, prices: $PRICES, totals: $totals, by_model: $by_model, by_lane: $by_lane, by_day: $by_day, unknown_price_models: $unknown_models} | to json | save -f $"($dir)/latest.json"
  }

  if $json {
    {since: $since_iso, prices: $PRICES, totals: $totals, by_model: $by_model, by_lane: $by_lane, by_day: $by_day, unknown_price_models: $unknown_models} | to json
  } else {
    print $"Token census — ($summary_line)"
    print "(cache-read is billed at 10% of input; cache-write at 1.25× (5-min) / 2× (1-hour) input; costs are list-price estimates from the table at the top of the script)"
    if ($unknown_models | length) > 0 { print $"⚠ no price row for: ($unknown_models | str join ', ') — priced at the default row" }
    print ""
    print "By model:"; print ($by_model | reject price_known | table)
    print "Aggregate:"; print ([$totals] | table)
    print "By lane (session directory):"; print ($by_lane | table)
    print "By day (UTC):"; print ($by_day | table)
  }
}
