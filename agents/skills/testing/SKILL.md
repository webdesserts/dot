---
name: testing
description: "Testing guidelines and philosophy. Use when writing, modifying, or reviewing tests, working with test files, deciding what kind of tests to write, adding snapshot or visual tests, or discussing test strategy and edge cases."
---

## Testing Philosophy

Tests validate the **user experience** — where "user" varies by product:

- **Application** → the person touching the UI
- **Library** → the developer consuming the API
- **CLI** → the person running commands (treat CLI output as its UI)

All tests should be grounded in **real-world user scenarios and edge cases**, never abstract or synthetic.

## Test Hierarchy

**Test at the smallest reliable boundary that owns the behavior.** Put detailed correctness tests in the owning crate or library: public-API integration tests for its contracts, focused unit tests for local logic and high-input-variation components. Use cross-system tests where the interaction itself is the risk, not to repeat every lower-level case.

Match effort to consequence, likelihood, expected lifetime, and maintenance cost. Temporary adapters and personal tooling generally need high-level smoke tests for the intended workflow, visible output, and major failures—not exhaustive validation of the host application's internals. Serious risks such as data loss or unauthorized effects still warrant targeted checks.

Before expanding coverage, name the observation, the actual problem for a consumer, and why solving it is worth the cost. A conceivable edge case is not automatically a requirement. If test scaffolding or repeated review cycles cost more than the remaining confidence they provide, report what is verified and propose the smallest next check or a deferral. Ask the owner when the value is unclear; don't silently waive agreed criteria or turn every finding into another test project.

## Spec Alignment

Always check for BDD specs (`specs/*.feature`) and keep tests in sync with them:

- Before writing tests, read relevant specs to understand expected behavior
- Call out when tests diverge from specs — this is a signal, not noise
- Add discovered edge cases to specs when they represent agreed behavior; don't promote every hypothetical case into a requirement

## Failing Tests Are Signals

Never "just get the test to pass." A failing test is telling you something:

- Is it exposing an edge case you didn't consider?
- Is it revealing a feature conflict?
- Did the implementation change the expected behavior?

Investigate what the failure means before deciding how to fix it. The fix might be in the code, not the test.

## Test Removal Policy

**Never remove a test because it's "too much trouble."** Removing a test without explicit user consent is never acceptable. Tests are an agent's eyes and ears — they validate your own work and catch regressions you can't see.

If a test seems wrong or outdated, flag it and discuss rather than deleting.

## Flaky Tests

Fix root causes rather than retrying or ignoring. A flaky test is a bug — either in the test setup or in the code under test. Common causes:

- Timing dependencies (use deterministic waits or mocks)
- Shared state between tests (isolate properly)
- External service dependencies (mock at the boundary)

## Visual and Snapshot Testing

**Core components should have visual tests.** Snapshot testing is your friend:

- Review snapshot diffs any time you change a visual aspect of a UI — don't just check pass/fail, look at the actual images
- On screenshot test failure, read the reference, actual, and diff images before attempting fixes
- If a screenshot's file size changes dramatically (e.g. 404KB → 13KB), investigate before accepting
- After modifying component rendering or CSS, proactively render and review screenshots

**CLI snapshot testing**: Treat CLI output as UI. Use input/output snapshot tests to ensure the actual output stays consistent across changes.

## Test Structure (Cucumber-Inspired)

### Organization

- **`describe()` blocks**: Focus on developer use cases and business scenarios, not just class/method names
- **Group by behavior**: Organize tests around what the user/developer is trying to accomplish
- **Nested contexts**: Use nested `describe()` blocks to set up different scenarios

### Naming

```typescript
describe("UserStore", () => {
  describe("new UserStore()", () => {
    it("should create a new UserStore", () => {});
  });

  describe("load()", () => {
    it("should load the user data", async () => {});
    it("should only update once when called multiple times", async () => {});
  });
});
```

### Context-Driven Scenarios

- Use scenario-based describes: "If one does not exist", "If one DOES exist"
- Focus on user intentions: What is the developer trying to accomplish?
- Test business rules with specific examples and concrete data

### Test Comments

Test comments should add context that isn't obvious from the test structure:

- Explain what changes/behaviors the test is specifically verifying
- Highlight edge cases or non-obvious scenarios
- Clarify business rules or domain concepts

Avoid restating obvious test names or explaining basic language constructs.

### Setup and Mocking

- Use `beforeEach()` for consistent test setup
- Mock at the service/environment level, not deep internals
- Create realistic test data that mirrors production scenarios

---

> For test type definitions (unit, functional, integration, smoke, regression, fuzz), see [[Testing]]
