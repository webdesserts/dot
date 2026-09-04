#!/bin/bash
# v6 (2026-08-28): index-anchored emission. After the 08-28 morning deploys the
# since=m:<hash> wire began returning ~2 PRE-cursor context entries (probe-proven:
# since=m:0tkh00eqeb returned 2 older msgs + cursor + newer), so v5's hash-!= filter
# re-emitted those context entries on every poll (duplicate storm). v6 emits only
# entries strictly AFTER the cursor's index in the response array; if the cursor hash
# is absent from the window, it re-baselines to the newest entry WITHOUT emitting
# (never dumps history). Everything else identical to v5.
BASE="http://127.0.0.1:4600"
CURSOR=""
LASTOK=$(date +%s)
while true; do
  if [ -z "$CURSOR" ]; then URL="$BASE/feed"; else URL="$BASE/feed?since=m:$CURSOR"; fi
  RESP=$(curl -sf -H "X-Auth-User: iris" "$URL")
  if [ $? -eq 0 ] && [ -n "$RESP" ]; then
    LASTOK=$(date +%s)
    if [ -z "$CURSOR" ]; then
      CURSOR=$(echo "$RESP" | jq -r 'last | .hash // empty')
    else
      IDX=$(echo "$RESP" | jq --arg c "$CURSOR" 'map(.hash) | index($c)')
      if [ "$IDX" = "null" ] || [ -z "$IDX" ]; then
        OLD="$CURSOR"
        CURSOR=$(echo "$RESP" | jq -r 'last | .hash // empty')
        echo "NOTE: cursor m:$OLD not in since-window; re-baselined to m:$CURSOR (nothing emitted)"
      else
        echo "$RESP" | jq -r --argjson i "$IDX" '
          .[$i+1:] | .[] | select(.author != "iris")
          | (if (.content | test("@iris")) then "MENTION " else "FEED " end)
            + .author
            + (if .reply_to then " (re m:" + .reply_to + ")" else "" end)
            + ": " + (.content | .[0:400])'
        NEW=$(echo "$RESP" | jq -r 'last | .hash // empty')
        [ -n "$NEW" ] && CURSOR="$NEW"
      fi
    fi
  else
    NOW=$(date +%s)
    if [ $((NOW - LASTOK)) -gt 2700 ]; then echo "ALERT: feed unreachable or cursor rejected for 45min (last cursor m:$CURSOR)"; LASTOK=$NOW; fi
  fi
  sleep 20
done
