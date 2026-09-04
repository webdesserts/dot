#!/usr/bin/env bash
# Nightly Obsidian vault consolidation orchestrator.
# Triggered by ~/Library/LaunchAgents/com.webdesserts.notetaker.plist at 3:00am local.
# Iterate the prompt at ~/.claude/prompts/nightly-consolidate.md without redeploying the plist.

set -uo pipefail

LOG_DIR="$HOME/.claude/logs/nightly-consolidate"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

PROMPT_FILE="$HOME/.claude/prompts/nightly-consolidate.md"
CLAUDE_BIN="$HOME/.local/bin/claude"

if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "[$(date)] FATAL: claude CLI not found at $CLAUDE_BIN" >> "$LOG_FILE"
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "[$(date)] FATAL: prompt file not found at $PROMPT_FILE" >> "$LOG_FILE"
  exit 1
fi

{
  echo "===================="
  echo "Run start: $(date)"
  echo "Prompt: $PROMPT_FILE"
  echo "===================="
} >> "$LOG_FILE"

# Give the network and any local MCP servers a moment to settle (umbra services, etc.)
sleep 30

cd "$HOME/notes"

# No-op detection baseline: a successful run always rewrites the report note.
REPORT_FILE="$HOME/notes/Nightly Consolidation.md"
PRE_MTIME=$(stat -f %m "$REPORT_FILE" 2>/dev/null || echo 0)

"$CLAUDE_BIN" \
  --print \
  --model sonnet \
  --permission-mode bypassPermissions \
  --add-dir "$HOME/notes" \
  --add-dir "$HOME/code" \
  --add-dir "$HOME/.dots" \
  --name "Nightly Consolidate" \
  "$(cat "$PROMPT_FILE")" \
  >> "$LOG_FILE" 2>&1

EXIT_CODE=$?

# A run that never touched the report did no work — surface it as a failure
# (2026-07-13 and 07-15 runs exited 0 after merely orienting and asking a question).
POST_MTIME=$(stat -f %m "$REPORT_FILE" 2>/dev/null || echo 0)
if [[ "$EXIT_CODE" -eq 0 && "$POST_MTIME" == "$PRE_MTIME" ]]; then
  echo "NO-OP RUN DETECTED: $REPORT_FILE unchanged — treating as failure" >> "$LOG_FILE"
  EXIT_CODE=1
fi

{
  echo "===================="
  echo "Run end: $(date) (exit code: $EXIT_CODE)"
  echo "===================="
} >> "$LOG_FILE"

exit $EXIT_CODE
