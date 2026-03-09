# Claude Code Reference

## Key Paths

- **`~/CLAUDE.md`** - Machine-specific context (computer name, network, etc.)
- **`~/.claude/CLAUDE.md`** - Personal global instructions (this file)
- **`~/.claude.json`** - MCP server configuration
- **`~/.claude/settings.json`** - Global permissions
- **`./.claude/settings.json`** - Project permissions (team-shared)
- **`./.claude/settings.local.json`** - Project permission overrides (git-ignored)
- CLAUDE.md files can import other files with `@path/to/file` syntax (max 5 hops)

**Project context preference**: Use Obsidian project notes instead of per-project CLAUDE.md files.

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

---

# Generic Workflow Guidelines

## Commit Workflow

**Commit automatically** after each reviewable unit of work. Never leave completed work uncommitted. Amend when fixing up the most recent commit, but check `git log origin/<branch>..HEAD` first — only amend unpushed commits.

**TDD approach**: When adding new behavior or fixing bugs in projects with tests, write a failing test first to define the expected behavior, then implement. Each commit bundles tests and implementation for one logical change — this makes commits individually reviewable.

**Commit messages**: Short subject line describing what changed. Optional brief description for bugs or important context. No attribution lines.

**Git safety**: Never push without permission. Never force push to main/master. Never skip hooks. Never amend other developers' commits.

## Implementation Approach - CRITICAL

### Major Design Decisions Require Approval

- **Never drastically diverge** from the current plan or approach without explicit user approval
- **Small technical decisions** (variable names, minor refactoring) are fine to make independently
- **Major architectural changes** (completely different API design, swapping dependencies) require a conversation and maybe even a new plan.

### If You Encounter Technical Blockers

1. **First**: Try to solve within the original approach
2. **Document**: What specific issue you encountered
3. **Propose**: Multiple alternatives with clear pros/cons for collaborative decision-making
4. **Wait**: For user decision before implementing alternative
5. **Never**: Just switch to different approach due to complexity

**Collaborative problem-solving**: When technical issues arise, present options rather than switching approaches unilaterally. The user may have insights or preferences that inform the best solution.

### Example Decision Points

```
❌ "Complex type inference is hard, so I'll make simple helper functions instead"
✅ "Complex type inference hit X technical issue. Options: A) Simpler helpers B) Different approach C) Solve complexity. Which do you prefer?"
```

### Code Reuse and Discovery

- **Search before creating**: Always look for existing types, utilities, and patterns before implementing new ones
- **Reuse existing code**: Prefer extending or using existing solutions over creating duplicates

## Remember

**NEVER use Bash** — use nushell for all shell operations!
**NEVER PUSH** without explicit user permission!
**ALWAYS SYNC** before making major architectural decisions or diverging from original approach!
**KEEP COMMITS CLEAN** - short messages, no co-author attribution, minimal description text!
