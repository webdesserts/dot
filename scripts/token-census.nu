#!/usr/bin/env nu
# token-census.nu — Claude Code token usage from the local transcripts on this machine.
#
# Reads every ~/.claude/projects/**/*.jsonl modified since --since, keeps assistant
# messages, de-duplicates by API request id (streamed content blocks repeat the same
# usage), and sums input / cache-write / cache-read / output tokens per model, per lane
# (session cwd), and per day. Zero model tokens spent — plain files in, a table out.
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

def main [
  --since: string = ""    # ISO date (local); default = 7 days ago
  --json                  # print one record instead of tables
  --log                   # append a one-line summary to the census log
] {
  let since_dt = (if $since == "" { (date now) - 7day } else { $since | into datetime })
  let since_iso = ($since_dt | date to-timezone utc | format date "%Y-%m-%dT%H:%M:%SZ")
  let root = ("~/.claude/projects" | path expand)

  # Files touched since the cutoff (mtime is a cheap pre-filter; the timestamp filter below is the real one).
  let files = (glob $"($root)/**/*.jsonl" | where { |f| (ls $f | get 0.modified) > $since_dt })

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
              {
                rid: ($m | get -o requestId | default ($m | get -o message.id | default $m.uuid)),
                ts: ($m | get -o timestamp | default ""),
                model: ($m | get -o message.model | default "?"),
                lane: (($m | get -o cwd | default "?") | path basename),
                input: ($u | get -o input_tokens | default 0),
                cache_write: ($u | get -o cache_creation_input_tokens | default 0),
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

  let sum = { |t| {
      requests: ($t | length),
      input_M: (($t | get input | math sum) / 1e6 | math round --precision 2),
      cache_write_M: (($t | get cache_write | math sum) / 1e6 | math round --precision 2),
      cache_read_M: (($t | get cache_read | math sum) / 1e6 | math round --precision 1),
      output_M: (($t | get output | math sum) / 1e6 | math round --precision 2),
  } }

  let totals = (do $sum $rows)
  let by_model = ($rows | group-by model | transpose model rows | each { |g| {model: $g.model} | merge (do $sum $g.rows) } | sort-by output_M -r)
  let by_lane = ($rows | group-by lane | transpose lane rows | each { |g| {lane: $g.lane} | merge (do $sum $g.rows) } | sort-by output_M -r)
  let by_day = ($rows | insert day { |r| $r.ts | str substring 0..9 } | group-by day | transpose day rows | each { |g| {day: $g.day} | merge (do $sum $g.rows) } | sort-by day)

  let summary_line = $"($since_iso | str substring 0..9)..(date now | format date '%Y-%m-%d') · requests ($totals.requests) · output ($totals.output_M) M · cache-write ($totals.cache_write_M) M · cache-read ($totals.cache_read_M) M · input ($totals.input_M) M"

  if $log {
    let dir = ("~/.claude/logs/token-census" | path expand)
    mkdir $dir
    $"(date now | format date '%Y-%m-%dT%H:%M:%S%z') ($summary_line)\n" | save --append $"($dir)/census.log"
    {generated: (date now | format date "%Y-%m-%dT%H:%M:%S%z"), since: $since_iso, totals: $totals, by_model: $by_model, by_lane: $by_lane, by_day: $by_day} | to json | save -f $"($dir)/latest.json"
  }

  if $json {
    {since: $since_iso, totals: $totals, by_model: $by_model, by_lane: $by_lane, by_day: $by_day} | to json
  } else {
    print $"Token census — ($summary_line)"
    print "(cache-read is the cheap tier; output + cache-write are what the limits count)"
    print ""
    print "By model:"; print ($by_model | table)
    print "By lane (session directory):"; print ($by_lane | table)
    print "By day (UTC):"; print ($by_day | table)
  }
}
