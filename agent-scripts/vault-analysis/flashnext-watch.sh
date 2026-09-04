#!/bin/bash
# Flash-Next readiness watcher.
#
# Two signals matter tonight:
#   1. llama.cpp PR #27742 (qwen4exp) merging  - the actual gate on running anything
#   2. unsloth publishing quants above UD-Q4_K_XL, or otherwise touching the repo
#
# Emits on CHANGE (including into and out of an error state, so a blind watcher
# announces itself rather than going quiet) plus a heartbeat every 8th poll, so
# there's a periodic nudge to go look even when nothing has moved.
#
# NOTE: keep f-string expressions free of nested double quotes. The first
# version used f"...{d[\"state\"]}..." inside a single-quoted python3 -c, which
# is a SyntaxError the `except` cannot catch - the whole -c fails and every
# poll reported UNREACHABLE. Bind subscripts to plain names first.

POLL=900          # 15 min - a PR under active review, not a fast-moving log
HEARTBEAT_EVERY=8 # ~2 hours

pr_state() {
  curl -s --max-time 30 https://api.github.com/repos/ggml-org/llama.cpp/pulls/27742 2>/dev/null \
    | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    # comment count is DELIBERATELY excluded: on an active review it churns
    # every few minutes and is not a readiness signal, so including it made
    # every poll look like a change. Commits PRINT for context but no longer
    # trigger CHANGED (2026-08-27: an active rebase fired 4 events in <1h;
    # the change-detection below strips the counter before comparing).
    state = d["state"]
    merged = d["merged"]
    commits = d["commits"]
    print(f"PR#27742 state={state} merged={merged} commits={commits}")
except Exception as e:
    print(f"PR#27742 UNREACHABLE ({type(e).__name__})")
' 2>/dev/null || echo "PR#27742 UNREACHABLE (curl/python failed)"
}

gguf_state() {
  curl -s --max-time 30 "https://huggingface.co/api/models/unsloth/Qwen3.8-Flash-Next-GGUF" 2>/dev/null \
    | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    quants = sorted({f["rfilename"].split("/")[0] for f in d["siblings"] if f["rfilename"].endswith(".gguf")})
    n = len(quants)
    names = ",".join(quants)
    mod = d["lastModified"]
    print(f"unsloth quants={n} [{names}] modified={mod}")
except Exception as e:
    print(f"unsloth UNREACHABLE ({type(e).__name__})")
' 2>/dev/null || echo "unsloth UNREACHABLE (curl/python failed)"
}

prev=""
n=0
while true; do
  cur="$(pr_state) || $(gguf_state)"
  # change-detection excludes the commits counter (still printed above):
  # merge/state/quants/UNREACHABLE are the transitions we act on.
  sig="$(printf '%s' "$cur" | sed -E 's/ commits=[0-9]+//')"

  if [ -z "$prev" ]; then
    echo "WATCH ARMED - baseline: $cur"
  elif [ "$sig" != "$prev" ]; then
    echo "CHANGED: $cur"
  elif [ $((n % HEARTBEAT_EVERY)) -eq 0 ]; then
    echo "heartbeat (no change): $cur"
  fi

  prev="$sig"
  n=$((n + 1))
  sleep $POLL
done
