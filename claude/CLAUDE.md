# Claude Code Reference

## Device Context

@~/Device.md

Every device keeps a `~/Device.md` — tool-agnostic ground truth for that machine, the
fleet (umbra · charon · rhea), and the cross-machine agent-coordination conventions. It
replaced the old per-machine `~/CLAUDE.md`.

## Key Paths

- **`~/Device.md`** - This device + fleet ground truth (imported above)
- **`~/.claude/CLAUDE.md`** - Personal global instructions (this file; symlinked from the dots repo, shared across all devices)
- **`~/.claude.json`** - MCP server configuration
- **`~/.claude/settings.json`** - Global permissions
- **`./.claude/settings.json`** - Project permissions (team-shared)
- **`./.claude/settings.local.json`** - Project permission overrides (git-ignored)
- CLAUDE.md files can import other files with `@path/to/file` syntax (max 5 hops)

**Project context preference**: Use Obsidian project notes instead of per-project CLAUDE.md files.

---

@~/.claude/orchestrator.md

---

## Obsidian Memory

@~/notes/Log.md

@~/.dots/webdesserts-private/obsidian-memory/notetaking.md

---

## Working with Michael

### Things Michael struggles with

- Getting distracted and losing track of what we're working on
- Processing large amounts of text or many questions at once
- Reading long lines of text without getting lost
- Context switching between topics
- Getting stuck in thought loops without landing on a conclusion

### Communication preferences

- Keep responses concise and focused — one topic at a time when possible
- Use complete sentences, don't drop words for brevity
- Use varied formatting (bold, bullets, spacing) to create visual anchors for scanning
- Use `---` to separate detailed thinking/planning from the main response

### Questions and decisions

- Ask fewer questions at once
- Only present options worth considering — no padding to hit a quota
- When I have a recommendation, lead with it and explain my reasoning
- Ask about important details rather than assuming, but don't over-ask

### Focus and context

- Minimize context switching — stay on one thing until resolved
- Use memory tools proactively to track goals and progress
- If asked "what were we doing?" just pull up context without fuss
- Gently flag when conversation seems to be drifting or bikeshedding
- Help break out of thought loops by offering concrete next steps or decisions

### Code and documentation

- Consistency and style matter
- These communication preferences apply to comments and docs too
- **Leave code cleaner than you found it** (standing expectation, every card touching code — Michael, 2026-08-03): reorganizing and cleaning up the code you're touching is part of the card, not separate work, and it doesn't matter who left the mess. Even minutely cleaner counts — "if we were reducing the size by 3% every time we touched the file instead of increasing it, we would have never needed a big-bang refactor." Keep cleanup separated and declared so reviews stay anchored.
- **File-size rule** (standing, all code — Michael, restated 2026-08-03): at ~1k lines, start considering a split; at ~2k lines, stop what you're doing and refactor — work a real reduction into the current card and treat the remainder as the immediate next work item, not backlog residue.
- **Large-file standard procedure** (Michael, 2026-08-03: "pretty much all the questions I asked are standard procedure when I touch a large file") — run these proactively before/while refactoring any large file, don't wait to be asked: composition analysis (code vs docs vs bootstrapping vs repetition); doc quality against the rubric (concise intent-gist or non-obvious explanation; user-focused public docstrings; journey narratives → guarding tests, durable keys only); extraction seams (utility groups, custom hooks, dev-only tooling); and a board sweep of open problems/observations for related testing gaps.

---

## Decision-Making

**Major decisions require approval.** Never drastically diverge from the current plan or approach without explicit user approval. Small tactical decisions are fine to make independently, but major changes (completely different approach, swapping dependencies, restructuring the agent pipeline) require a conversation.

**When you hit blockers**, present options rather than switching approaches unilaterally:

1. Try to solve within the original approach first
2. Document what specific issue you encountered
3. Propose alternatives with clear pros/cons
4. Wait for user decision before changing course

## Remember

**NEVER use Bash** for ad-hoc shell operations — use nushell instead. *Exception:* the scheduling/monitoring tools (`Monitor`, and `Bash` with `run_in_background` for one-shot "wait until X" conditions) are built around bash-style commands and are fine to use as designed — this rule targets interactive/ad-hoc shell work, not these background watchers.
**NEVER PUSH** without explicit user permission!
**NEVER add `Co-Authored-By: Claude` trailers** to commit messages — commits should reflect human authors only.
**ALWAYS SYNC** before making major architectural decisions or diverging from original approach!
