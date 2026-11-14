---
name: planning
description: "Source-grounded implementation plans, User vs. Agent acceptance criteria, and proportionate plan critique. Use when designing features, writing implementation briefs, or reviewing plans."
---

# Implementation Planning

An implementation plan is a **falsifiable, source-grounded hypothesis** — detailed enough to align on user outcomes, module boundaries, and risks up front, while leaving routine local coding choices to whoever implements it.

## 1. Ground Plans in Live Source & Real Consumers

- **Verify assumptions before locking design:** Check actual file paths, exported types, existing utilities, callers, and runtime environments (such as clean `launchd` / daemon environments vs. interactive login shells) rather than designing against memory. Reuse existing mechanisms before introducing parallel state or new abstractions.
- **Separate `User Criteria` (`UC-*`) from `Agent Criteria` (`AC-*`):**
  - **`User Criteria` (`UC-*`):** What a person or external caller actually experiences — an installed `.app` bundle, a working CLI command, a rendered UI state, or a verified multi-device workflow.
  - **`Agent Criteria` (`AC-*`):** The internal crates, protocol messages, migrations, endpoints, and test suites that power those deliverables.
  Keeping the two distinct prevents backend plumbing from being mistaken for a finished user feature across multi-phase work.
- **Right-sized slices:** Group work into coherent increments that can be implemented, tested at their owning boundary, and reviewed cleanly — avoiding both sprawling multi-concern branches and slices so tiny that coordination costs more than the code.

## 2. What Makes an Implementation Brief Useful

Adapt depth to the size of the task, covering the context an implementer would otherwise have to rediscover:

- **Why / intent & observable acceptance:** Who benefits, what changes in observable behavior, and what stays out of scope.
- **Drift-resilient source anchors:** Owning file paths, type/function symbols, and downstream callers to update — preferring symbol names over brittle line numbers or large pasted code blocks that go stale after nearby edits.
- **Constraints, migrations & authority gates:** Settled tradeoffs, non-destructive config/state migration steps, build/test commands, and clear boundaries around commits, pushes, or live-service restarts.

## 3. Proportionate Plan Critique

When reviewing a plan before implementation, optimize for catching costly mistakes early without manufacturing ceremony:

- Focus on **falsifiable risks**: wrong codebase or runtime assumptions, missing caller/state propagation, broken migration or deploy ordering, security/privacy footguns, and unresolved user-facing tradeoffs.
- State the concrete consequence and the smallest clean adjustment, separating **material blockers** from **open product questions** and **optional suggestions**.
- When a plan's boundaries, contracts, and checks are sound, saying "clear to build" is better than inventing extra abstraction layers or speculative edge cases.
