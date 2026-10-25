---
name: planning
description: "Write or assess source-grounded implementation plans and worker briefs. Use for orchestrator planning, design decisions that guide implementation, and focused plan critique."
---

# Implementation planning

The orchestrator owns the overall plan, forecasts and reflection. This skill helps it produce a useful brief and helps a worker or reviewer assess one. It does not require a Planner or Forecast Reviewer agent.

Plans are forecasts, not edit scripts or grants of authority. Resolve behavior, architecture and authority decisions while leaving routine implementation choices to the Worker.

## Start from the source and consumer

Read relevant specs, documentation, types, utilities, callers and tests. Use what already solves the problem rather than inventing a parallel mechanism.

Choose the smallest coherent outcome that provides useful value to an identified user and can be implemented, checked and handed off together. The user is not necessarily a UI user: a developer consuming a new API is a user, and that usable API can be a delivered feature. Name who benefits, what they can now do and the relevant consumer/integration check. Chunks should generally have user impact; necessary preparatory work is valid, but identify the outcome it enables rather than presenting an internal helper, test or report as a delivered feature. Do not split so finely that handoffs cost more than the work.

For substantial work, keep a high-level plan and a separate checkbox task list. For a small task, a compact brief may suffice. Preserve one current outcome, blocker and next action rather than several competing plans.

## Include what the Worker needs

Not every plan needs every section, but cover the facts that affect implementation:

- **Outcome and criteria:** agreed observable behavior, consumer, priorities and boundaries. Separate core criteria from authorized optional finishing work.
- **Starting state:** cwd, branch/revision, relevant instructions, existing partial/unrelated work and trustworthy predecessor evidence.
- **Files and patterns:** likely owning paths and symbols, existing types/utilities to reuse, important callers and downstream propagation.
- **Decisions and risks:** settled choices, assumptions, dependencies and stop conditions for surprises that change behavior, scope or authority.
- **Checks and delivery:** meaningful regression/consumer checks, visual evidence where relevant, existing build/lint commands, output binding and remaining integration gates.
- **Allowed effects:** distinguish source edits, formatting, commits, integration, activation and live operations. For error-prone mechanical work, specify exact permitted commands and paths.
- **Forecast:** expected output, preparation, implementation, verification and handoff time. Keep the original estimate visible and label uncertainties rather than inventing precise numbers.

Plan commit boundaries when commits are authorized and useful; do not impose an arbitrary commit count or assume every chunk permits a commit.

## References that survive drift

Prefer file paths plus symbols, types or search hints over exact line numbers and long copied snippets. Use bounded native search/glob tools for the relevant source. A line anchor can support current review evidence, but should not be the only instruction for a later edit.

Do not grade a source-supported plan as incorrect merely because line numbers moved. Ask whether its owning symbol, consumer or proposed mechanism is actually wrong.

## Design principles

- Prefer a root-cause fix. Escalate a required major architectural change rather than quietly substituting a brittle workaround.
- Reuse domain types and canonical definitions. Do not add stringly typed parallel state or abstractions without a consumer.
- Preserve testability, diagnosis and current documentation. Comments describe intentional behavior, not an incident transcript.
- Update changed callers and remove obsolete/dead code when the agreed migration requires it. Call out compatibility and breaking changes.
- Keep implementation and tests readable and small. Target source files under 1,000 lines and respect the hard 2,000-line cap or a narrower project limit. Propose a cohesive extraction when necessary; compressed code or omitted tests do not make a plan fit.
- Keep task-related improvements distinct from unrelated cleanup. Optional UX/DX, architecture and documentation work may use an agreed finishing timebox; it is not unlimited scope.

Use [architecture review](../architecture-review/SKILL.md) for a consequential boundary/dependency choice, [BDD](../bdd/SKILL.md) for ambiguous behavior, and [testing](../testing/SKILL.md) for proportionate evidence.

## Critique without manufacturing work

Read the whole plan and its criteria before raising a finding. Prioritize incorrect source assumptions, missing necessary propagation, impossible mechanisms, wrong dependency order and unresolved consequential decisions. Context statements and already-addressed concerns are not defects.

Explain the concrete consequence and smallest correction. Separate material blockers, nonblocking improvements, open questions and outside-criteria suggestions. Do not make speculative rare cases, cosmetic preferences or a demand for more abstraction into acceptance conditions. An optional suggestion should add something beyond paraphrasing an issue's fix. Finding no material issue is a legitimate result.

## Keep the next forecast honest

Budget learning, checks and delivery together. If preparation or review starts overtaking the useful result, simplify before adding another stage. Compare expectations with actual milestones and outcomes, including the quality of the brief and supervision. Distinguish observed durations, external waits and estimates without summing overlapping intervals.

Report material drift early. Recommend changed approach, order or scope to the orchestrator; Michael agrees to criterion cuts or timeline changes. Never silently reduce the criteria, skip essential verification or call an unfinished result complete.
