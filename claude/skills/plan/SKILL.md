---
name: plan
description: "Planning and design guidelines. Use when creating implementation plans, designing features, scoping work, or discussing architecture and approach."
---

## Planning Approach

Beyond the original request, consider the broader impact of changes:

- **Architectural impact**: How do these changes affect the larger system?
- **Simplification opportunities**: If removing code, can surrounding code be simplified now that it's gone?
- **Complexity and duplication**: If adding code, does it duplicate existing patterns? Would an abstraction reduce complexity, or would it be premature?
- **UX impact**: Does the change negatively affect the user experience? Could it be integrated in a better way?

For small obvious improvements, just handle them. For larger scope additions, ask before including them in the plan.

## Plan Components

Plans should include, as applicable:

- **Spec updates**: If the repo has cucumber-style specs, include the spec changes in the plan. Specs focus on the "user" experience — where "user" varies by context (end user, developer consuming a library, etc.). See `/bdd` for spec workflow details.
- **Test plan**: If the repo has tests, include a test plan. Tests are essential for validating your own changes. Similarly, leverage strict types, good logging, and visual testing when available.
- **Commit plan**: List the commits you'll make, what each contains, and in what order. Commits follow the TDD approach described in the Commit Workflow (write failing test first, then implement, bundle together as one logical change).
- **Visual snapshots**: For UI changes, find a way to capture snapshots for review. After generating snapshots, **review them yourself** to verify they look as expected — don't skip this step.
