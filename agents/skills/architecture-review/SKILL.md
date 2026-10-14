---
name: architecture-review
description: "Evaluate architecture, dependency choices, abstraction boundaries and simplification for a scoped plan or change. Use when a task has meaningful cross-module or long-term design consequences."
---

# Architecture review

Help the orchestrator make a consequential design decision or assess the combined effect of related changes. This is an optional review perspective for the orchestrator, Worker or Claim Reviewer, not a separate seat or a mandatory stage.

## Start with the decision

Identify the consumer, current architecture, constraints and choice that needs judgment. Read the relevant types, boundaries, callers, tests and documentation before proposing a new abstraction. For accumulated changes, examine how they compose rather than treating each diff as independent.

Compare only credible alternatives. Keep the recommendation proportional to consequence, likelihood, reversibility and expected lifetime.

## What to examine

- **Boundaries:** ownership of state, responsibility, data flow, dependencies and public contracts. An abstraction should simplify its actual callers, not anticipate a hypothetical future use.
- **Patterns:** consistency with existing types, utilities and failure handling. Explain when a difference is justified rather than demanding uniformity.
- **Dependencies:** the problem a dependency solves, maintenance, compatibility, operational cost and migration burden. Use verified primary sources for important external claims; ask Researcher for evidence when the assigned tools do not support web research.
- **Evolution:** compatibility of existing callers, transition strategy, rollback and likely maintenance costs. Identify incomplete consumer wiring and duplicated sources of truth.
- **Simplification:** unnecessary layers, parallel mechanisms, obsolete code and task-related debt worth paying down. A useful smaller design is often better than adding another framework.
- **Diagnosis and checks:** whether the proposed behavior can be explained, observed and tested at its owning boundary.

Do not turn a narrow task into a codebase-wide cleanup. Separate a material decision/blocker from optional long-term improvements, and identify the next consumer of a proposed helper before recommending preparation work.

## Return a decision-ready result

State the observed structure, viable options, recommendation, evidence, tradeoffs and unresolved decision. Explain reachable consequences, not generic slogans. Keep approved residuals distinct from newly discovered risk.

The caller's authority remains unchanged: this skill grants no edits, live operations, probing, web tools or note-writing. Preserve findings in the configured report or offer them to the orchestrator for the appropriate note. See [planning](../planning/SKILL.md) for implementation briefs and [testing](../testing/SKILL.md) for checks.
