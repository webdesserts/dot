---
name: bdd
description: "Low-ceremony Gherkin specs (specs/*.feature) for negotiating and documenting durable user-observable behavior. Use when working with .feature files or clarifying complex feature contracts."
---

# BDD (`specs/*.feature`)

Gherkin (`Feature` / `Scenario` with `Given / When / Then`) gives complex or user-facing behavior a **durable, human-readable contract inside the repository** that stays legible long after design threads scroll away.

## 1. When Gherkin Earns Its Keep (and When to Skip It)

- **Good fit:** New product capabilities, multi-state workflows, subtle CLI/API edge cases, or cross-component interactions where aligning on observable outcomes *before* writing code prevents rework and documents intent for future maintainers.
- **Skip the ceremony:** Internal refactors, performance tuning, straightforward bug fixes, and operational chores rarely benefit from `.feature` files — a clear brief and targeted unit/regression test communicate the contract with less overhead.

## 2. Writing Scenarios That Survive Refactors

- **Describe observable state and outcomes, not implementation:** Phrase `Given` (initial domain state), `When` (user or API caller action), and `Then` (observable result, persisted effect, or surfaced error) in domain terms rather than CSS selectors, private helper names, or wire internals.
- **Concrete examples over abstract prose:** One realistic example of a boundary condition (an expired token, a conflicting edit, an empty directory) exposes ambiguity faster than a paragraph of prose.
- **Update specs alongside intentional behavior changes:** Keep `specs/*.feature` aligned with current agreed behavior and prune superseded scenarios so the directory remains trustworthy documentation rather than historical sediment.

## 3. Surfacing Ambiguity Without Inventing Scope

Scenario drafting (typically during design or orchestration) is a tool for discovering hidden assumptions early:

- Look for contradictions with existing scenarios and consequential gaps around empty inputs, failure recovery, permissions, or concurrent access.
- Surface genuinely ambiguous product choices to the project owner as concrete questions (with consumer impact and options) rather than silently turning every imaginable edge case into a requirement.
- Verify accepted scenarios at the **smallest boundary that owns the behavior** (unit, CLI, or integration) rather than duplicating every `.feature` scenario as a slow end-to-end test.
