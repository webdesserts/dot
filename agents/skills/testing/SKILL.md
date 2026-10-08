---
name: testing
description: "Testing guidelines and philosophy. Use when writing, modifying, or reviewing tests, working with test files, deciding what kind of tests to write, adding snapshot or visual tests, or discussing test strategy and edge cases."
---

# Testing

Test behavior that matters to the person or developer using the product. Use concrete examples; small synthetic fixtures and mocks are useful when they faithfully represent that behavior.

## Choose checks by risk

Before adding coverage, identify what could fail, who would be affected, and the likely consequence. Consider exposure, reversibility, expected lifetime and maintenance cost. Choose the cheapest reliable evidence for that risk; a short explanation is usually enough.

- Put detailed correctness checks at the smallest boundary that owns the behavior.
- Use cross-system tests when the interaction is the risk, not to repeat every lower-level case.
- Temporary adapters and personal tools usually need a workflow smoke check and important failure checks, not exhaustive tests of their host.
- Data loss, unauthorized effects and difficult recovery deserve targeted safeguards even in temporary work.

A conceivable edge case is not automatically a requirement. Check relevant BDD specs and agreed criteria; add scenarios only when they describe accepted behavior.

Stop expanding coverage when the agreed behavior and material risks have adequate evidence. If scaffolding or repeated reviews cost more than the confidence they add, narrow the next check or propose deferral. Escalate unresolved changes to agreed requirements; do not silently waive them.

## Write useful tests

Name tests for the behavior and expected outcome. Prefer public or owning-library interfaces over copied implementation logic. Isolate mutable state in memory or uniquely owned temporary data. Mock external boundaries rather than deep internals.

Use deterministic events or clocks instead of sleeps where practical. Keep setup and assertions readable; comments should explain a non-obvious rule, not restate the code.

For a behavioral fix, prefer a regression test that fails for the actual defect and passes after correction. Compilation failure alone does not demonstrate a behavioral guard. Tests may arrive with signature or type changes; say what was actually observed.

## Treat failures honestly

Classify the failure before changing code or expectations. Fix the cause, not merely the test result. Do not retry an unchanged failure until it passes or repair unrelated behavior to hide it.

Flaky tests are defects to investigate. Removing tests requires explicit user consent; do not delete a failing check because it is inconvenient. Flag obsolete or incorrect tests and resolve the intended behavior.

Preserve relevant failed results. Distinguish executed checks from source inspection, simulation and unverified claims.

## Visual and output checks

When appearance or interaction changes, inspect the rendered result. Add visual or output snapshots when they provide stable, useful regression coverage; they are not mandatory for every component.

Review meaningful snapshot differences before accepting them. On a screenshot failure, inspect the reference, actual and difference images. Treat CLI output as an interface too, using focused output checks where its contract matters.

At a significant milestone or overrun, note which checks found real problems and which added little value. Use that evidence to choose the next checks, not to add another routine review layer.

See the BDD skill for behavior negotiation and [[Testing]] for test-type definitions.
