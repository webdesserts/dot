---
name: planning
description: "Planning standards for code-changing work. Use when writing implementation plans (manual-mode harness tasks, Planner subagent output, design docs that drive a Coder) OR when reviewing plans (grading rubric for issues, suggestions, severity). The producer and the grader follow the same rules — discrepancies between the two are the noise this skill exists to prevent."
---

## What a code-plan should contain

Not every plan needs every section. Include what the Coder will actually need to ship the work:

- **Files to modify** — Specific paths and what changes each one needs. Identify them by *path*, not by line number.
- **Existing patterns to reuse** — Types, utilities, helpers already in the codebase, cited by path + symbol name. Search before proposing new code; reusing is almost always better than inventing parallel infrastructure.
- **Test plan** — Which tests to write or update, following the project's existing test patterns. See the [[testing]] skill for what kind of test belongs where.
- **Commits** — How the work breaks into commits (in order). A Coder typically ships 1-3 commits per dispatch comfortably; 5+ tends to exhaust their budget.
- **Validation** — What checks gate "done." Build commands, type checkers, test commands, linters the repo uses. Discover these from the repo's docs/CI config; don't invent.
- **Risks & decision points** — Anything the orchestrator should decide before the Coder starts, or hazards the Coder should be alert to mid-flight.

## References that survive code drift

This is the single rule that prevents the most plan-vs-reviewer friction:

> **Pin to symbols + grep patterns, not line numbers.**

Files change between plan-write and plan-execute time. Line numbers drift; symbols stay stable. A plan that says "modify line 1467" is wrong as soon as someone adds 5 lines above it. A plan that says "modify `move_task` — locate with `rg -n 'pub async fn move_task' crates/task-server/src/routes.rs`" stays valid until the function is renamed.

**Always do:**
- Use function name, type name, module path, or const name.
- Pair with a concrete grep hint: `` `rg -n 'fn parse_status' src/` `` or `` `rg -n '^pub struct CreateTaskRequest' crates/` ``.
- Cite file paths normally — those rarely drift.

**Never do:**
- "Around line 245" / "line 1467-1538" / "lines ~600-690" — even with "approximately," line numbers in plans become reviewer-finding fodder.
- Long verbatim code snippets in lieu of references — the snippet rots; the symbol doesn't.

**For graders:** if a plan cites line numbers, raise it as `low` (or `medium` if it would cause real implementation confusion). If a plan correctly uses symbols, do NOT flag the corresponding source-code line numbers as drift — that's the planner doing the right thing.

## Principles

When proposing changes (or grading proposals), keep these in mind:

- **Don't add unwanted features.** If the user didn't ask for it, don't add it — or ask first. Plans that bundle unrelated improvements are scope creep.
- **Find the root.** Prefer root-cause fixes over hotfixes. If root-causing requires a major architectural change, surface that to the user instead of papering over.
- **Leave it better than you found it.** Don't take shortcuts that leave messes for the next person. Small refactors/utility work IS in scope if they make the change you're proposing cleaner — but don't bundle unrelated cleanup.
- **Ensure debuggability and testability.** If this code breaks in production, how would you diagnose? Will tests catch it? Reuse existing logging patterns; don't introduce parallel infrastructure.
- **Don't leave dead or legacy code.** When an API changes, update the callers. Don't keep dead code "just in case."
- **Anchor to the destination, not the journey.** Code comments describe what the code does now, not what it used to do. Tests assert what the code should produce, not what today's specific bug produced.
- **Avoid string literals as references.** When a string identifies a categorical value with a canonical definition (status name, event type, kind, tag), name it once (`const`, enum variant) and reference the symbol everywhere. Fine for inline values, test fixtures, and the canonical definition site itself.
- **Communicate breaking changes.** Call them out. If unsure whether a migration is needed, ask. Greenfield apps can break cleanly; widely-used libraries cannot.
- **Keep source files small.** Target under 1,000 lines per source file; hard cap at 2,000. Above the cap, every reviewer pass re-reads the whole file — token cost compounds. If a file you're touching is already over, prefer extracting tests or peeling off a cohesive submodule rather than adding more.

## Before proposing a solution, look for…

- Related documentation — READMEs, contributing guides, comments
- Existing types or interfaces that cover the need
- Utility functions that already do what's needed
- Patterns established elsewhere in the codebase
- Existing tests that operate on the code you'll be touching

If the codebase already has a solution, the plan should use or modify it — not reinvent it.

## Out-of-scope discipline

Plans bundle scope creep silently if the planner isn't careful. Before adding a step, ask: *does the task's explicit objective require this?* If the answer is "no but it would be nice," the addition goes in a follow-up note, not the plan.

For graders: if a finding addresses something outside the stated task scope (unrelated refactors, generic code-quality polish, architectural changes the ticket didn't ask for), mark it **out-of-scope** and do NOT raise it as an issue or suggestion. Only raise findings that directly affect whether the plan achieves the task's stated objective.

## Severity / Impact calibration (for graders)

**Issues** use `severity`:
- **high** — would cause implementation failure or require replanning
- **medium** — would cause confusion or require rework of one or more steps
- **low** — real improvement but the plan works without it
- **very_low** — polish, not substance. *Nits.* Don't raise these except when 3+ accumulate in the same category (which signals a real specificity problem worth one consolidated finding).

**Suggestions** use `impact`:
- **high** — significant improvement to plan quality
- **medium** — meaningful but not critical
- **low** — nice to have
- **very_low** — minor polish; usually don't raise.

**Suggestions must stand alone.** A suggestion that just paraphrases an issue ("do X to fix the issue I raised") is noise — the issue already implies the fix. Only raise a suggestion if it offers an improvement the plan didn't consider AND isn't tied to an issue elsewhere in the same review.

**A reviewer that keeps finding things on a solid plan is failing, not succeeding.** Empty `issues` and empty `suggestions` is the correct answer when the plan is solid. Don't manufacture findings to look thorough.

## What IS and ISN'T a plan issue (grader checklist)

**IS an issue:**
- Plan states something factually wrong about the code (file/function that doesn't exist, pattern described incorrectly)
- Plan is missing a step necessary for the proposed changes to work
- Plan has steps in the wrong order (references something before creating it)
- Plan's proposed change won't work as described (violates an existing constraint)

**Is NOT an issue:**
- A description of the current state of the code — that's context, not a problem.
- A description of what the plan proposes to add — that's the plan working correctly.
- Something the plan already addresses — read the WHOLE plan before flagging gaps. Misreads of the plan are the most common false-positive category.
- A hypothetical concern about edge cases the plan wasn't asked to solve.
- A request for more abstraction or configurability when the plan's direct approach is sound.
- A style preference about plan wording without a concrete cost to the implementation.

## Cross-references

- [[testing]] — what kind of test to write where, isolation discipline, observable-behavior assertions
- [[bdd]] — BDD scenario style (when the repo uses `.feature` files)
