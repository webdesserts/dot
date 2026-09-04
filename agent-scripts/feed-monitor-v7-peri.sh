#!/bin/bash
# Peri's feed:main watcher v7 (armed via the Monitor tool, persistent). ts-monotone cursor over the
# tail route: emits posts by others with ts strictly after the cursor; baselines quiet on first poll
# (never replays history); reports board unreachable/back. Body is byte-exact from the session
# transcript's Monitor input #144 (2026-09-01) — do not retype, edit the file.
cursor_ts=""; down_since=""; warned=0
while true; do
  out=$(curl -s -m 10 -H 'X-Auth-User: peri' "http://localhost:4600/feed:main.m:*?tail=15" 2>/dev/null)
  if [ -z "$out" ] || [ "$(printf '%s' "$out" | jq -r 'type' 2>/dev/null)" != "array" ]; then
    if [ -z "$down_since" ]; then down_since=$(date +%s); fi
    if [ $(( $(date +%s) - down_since )) -ge 300 ] && [ "$warned" = "0" ]; then echo "BOARD UNREACHABLE for 5+ min (since $(date -u -r $down_since +%H:%MZ)) — last body head: $(printf '%s' "$out" | head -c 160)"; warned=1; fi
    sleep 20; continue
  fi
  if [ -n "$down_since" ]; then echo "BOARD BACK (was degraded since $(date -u -r $down_since +%H:%MZ))"; down_since=""; warned=0; fi
  if [ -z "$cursor_ts" ]; then cursor_ts=$(printf '%s' "$out" | jq -r 'map(.ts) | max // empty' 2>/dev/null); echo "ARMED quiet at ts=$cursor_ts"; sleep 20; continue; fi
  new=$(printf '%s' "$out" | jq -r --arg t "$cursor_ts" '[.[] | select(.ts > $t and .author != "peri")] | sort_by(.ts) | .[] | "[\(.author)]\(if .reply_to then " re:\(.reply_to)" else "" end) m:\(.hash) \(.content | gsub("\n"; " ⏎ ") | .[0:1200])"' 2>/dev/null)
  maxts=$(printf '%s' "$out" | jq -r --arg t "$cursor_ts" '[.[] | select(.ts > $t)] | if length > 0 then (map(.ts) | max) else empty end' 2>/dev/null)
  if [ -n "$new" ]; then printf '%s\n' "$new"; fi
  if [ -n "$maxts" ]; then cursor_ts=$maxts; fi
  sleep 20
done
