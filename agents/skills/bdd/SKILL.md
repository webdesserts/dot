---
name: bdd
description: "BDD spec workflow using Gherkin syntax. Use when working with .feature files, writing specs or scenarios, negotiating feature behavior with Given/When/Then, or planning features for personal projects."
---

# BDD specs

Use Given/When/Then scenarios to agree on meaningful behavior before implementing it. Focus on what users or API consumers can observe, including internal state that affects their experience.

BDD is useful when behavior is new, ambiguous or complex. Not every operational plan, internal edit or temporary check needs a spec section. A short statement of expected behavior may be enough.

## Workflow

1. Read the relevant existing specs and clarify the intended change.
2. For a behavior change, update the spec before implementation so the difference is explicit. In personal projects, keep accepted scenarios in `specs/*.feature`.
3. Assess discovered edge cases by consequence, likelihood and cost. Add a scenario when it represents agreed behavior; otherwise record, defer or discard it rather than inventing a requirement.
4. Verify agreed scenarios at the smallest reliable owning boundary. Use cross-system checks only where the interaction needs them.

Use realistic examples; synthetic or minimized data is appropriate when it preserves the behavior under discussion. Do not duplicate every scenario across test layers.

The testing skill owns risk-based check selection and stopping rules. Keep specs concise and current; do not retain obsolete scenarios as conflicting instructions.
