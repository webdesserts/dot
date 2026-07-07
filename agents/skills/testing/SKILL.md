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

**Prefer e2e and integration tests over unit tests.** Unit tests fill gaps for:

- High-input-variation components (parsers, validators)
- Widely-reused internals where the blast radius of a bug is large

When deciding what to test, start from the user's perspective and work inward. If an integration test covers the behavior, a unit test for the same path adds cost without value.

## Spec Alignment

Always check for BDD specs (`specs/*.feature`) and keep tests in sync with them:

- Before writing tests, read relevant specs to understand expected behavior
- Call out when tests diverge from specs — this is a signal, not noise
- When edge cases are discovered during testing, add them as new spec scenarios too

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
