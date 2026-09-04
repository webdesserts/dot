#!/bin/bash
# umbra memory guard v12 (armed via the Monitor tool, persistent). Fires when llama-server RSS >= 76GB
# (ps, KB) or memory_pressure free% <= 8; 120s poll; any fire = escalate to Michael. Body byte-exact
# from the session transcript's Monitor input #133 (2026-09-01).
while true; do
  PID=$(pgrep -f 'llama-server' | head -1)
  if [ -n "$PID" ]; then
    RSS=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
    if [ -n "$RSS" ] && [ "$RSS" -ge 79691776 ]; then
      echo "GUARD v12: llama-server RSS ${RSS}KB >= 76GB at $(date -u +%H:%M:%SZ) — escalate to Michael"
    fi
  fi
  FREE=$(memory_pressure 2>/dev/null | grep -o 'free percentage: [0-9]*%' | grep -o '[0-9]*')
  if [ -n "$FREE" ] && [ "$FREE" -le 8 ]; then
    echo "GUARD v12: system memory free ${FREE}% <= 8% at $(date -u +%H:%M:%SZ) — escalate to Michael"
  fi
  sleep 120
done
