---
name: bdd
description: "BDD spec workflow using Gherkin syntax. Use when working with .feature files, writing specs or scenarios, negotiating feature behavior with Given/When/Then, or planning features for personal projects."
---

## BDD Specs

BDD-style specs define expected behavior using Gherkin syntax (Given/When/Then). These are the negotiation ground for how features should work.

**Scope**: User-facing behavior — UI/UX, tool interactions, and system states that affect what users experience. This includes internal states (like sync/connection status) when they surface in the UI.

**For all projects**: Every plan doc should include a BDD-style spec section. Even when specs can't be persisted, use them to negotiate feature behavior during planning. See `/plan` for how specs fit into the broader planning process.

**For personal projects**: Persist specs in `specs/*.feature` files.

## Workflow

1. **Before implementing**: Read relevant specs to understand expected behavior
2. **When behavior changes**: Edit the spec first — the diff shows what's changing
3. **When edge cases are discovered**: Add them as new scenarios
4. **Before completing**: Verify tests cover spec scenarios
