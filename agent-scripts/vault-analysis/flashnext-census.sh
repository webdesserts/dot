#!/bin/bash
# Flash-Next MTP-head census (autonomy/t:218 unpark trigger).
# Fetches the current Q8_0 shard-1 header (~11MB, kv incl. any
# nextn_predict_layers key) + 2MB heads of shards 2-6 (their tensor
# directories) and greps for nextn. HIT = head appeared -> unpark t:218.
set -u
REPO="unsloth/Qwen3.8-Flash-Next-GGUF"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

MOD=$(curl -s --max-time 30 "https://huggingface.co/api/models/$REPO" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["lastModified"])' 2>/dev/null || echo UNKNOWN)

FILES=$(curl -s --max-time 30 "https://huggingface.co/api/models/$REPO/tree/main/Q8_0" | python3 -c 'import sys,json; [print(f["path"]) for f in json.load(sys.stdin)]' 2>/dev/null)
if [ -z "$FILES" ]; then echo "CENSUS UNREACHABLE (tree fetch failed) modified=$MOD"; exit 1; fi

TOTAL=0
for F in $FILES; do
  case "$F" in
    *00001-of-*) RANGE="" ;;   # shard 1 is ~11MB, take it all (kv lives here)
    *) RANGE="-r 0-2097151" ;; # other shards: 2MB header = tensor directory
  esac
  curl -sL --max-time 120 $RANGE -o "$TMP/part" "https://huggingface.co/$REPO/resolve/main/$F"
  N=$(strings -a "$TMP/part" | grep -c nextn || true)
  TOTAL=$((TOTAL + N))
done

if [ "$TOTAL" -gt 0 ]; then
  echo "HIT: nextn present ($TOTAL strings) — unpark autonomy/t:218. modified=$MOD"
else
  echo "PARKED: still headless (0 nextn across Q8_0 shard headers). modified=$MOD"
fi
