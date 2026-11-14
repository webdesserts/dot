---
name: testing
description: "Risk-proportionate testing strategy, boundary selection, and blessed test tooling across TypeScript, Rust, UI, and Nushell. Use when writing, reviewing, or scoping tests."
---

# Testing

Tests earn their keep when they protect **user- or caller-observable behavior at the smallest boundary that owns the risk**, without turning test scaffolding into a second product to maintain.

## 1. Scope by Risk and Owning Boundary

Before adding checks, weigh what can fail, how silent or irreversible that failure would be, and what maintaining the test costs:

- **Smallest owning boundary:** Verify parsing, state transitions, and error variants directly through the owning module's public API. Save cross-system or process-level integration tests for risks that actually live in wiring, persistence, IPC, or CLI contracts rather than re-running every unit branch end-to-end.
- **Weight toward irreversible consequences:** Data loss, corrupted migrations, auth/privacy leaks, and silent fallbacks warrant targeted regression guards even in small tools; low-blast-radius formatting or throwaway glue usually needs only a focused workflow check.
- **Stopping point:** Once agreed contracts and material failure modes have clear evidence, stop adding permutations. If test harness complexity starts outgrowing the change itself, pause and reassess scope with the project owner.

## 2. One Tool per Problem

Using a single default runner per boundary keeps repos consistent and avoids overlapping dependencies:

- **Core TypeScript, Node services & CLIs (`node:test` + `node:assert/strict`):** Built into Node `26+` with zero extra dependencies (`t.test`, `t.mock.fn()`, `t.mock.timers`). *(Type-narrowing quirk: `@types/node` types `assert.deepEqual(actual, expected)` as `asserts actual is T`, so `assert.deepEqual(arr, [])` narrows a mutable `arr` to `never[]`; assert `arr.length === 0` when `arr` is mutated later in the test.)*
- **Frontend UI & React components (`vitest` + `@testing-library/react`):** Fast in-process checks driven through user-visible roles, labels, and `user-event` interactions rather than internal component state.
- **Rendered browser & layout checks (`Playwright`, interactive/manual first):** `jsdom` cannot compute real CSS layout, scrolling, or viewport overflow. Use Playwright or headless Chromium screenshots to inspect rendered desktop/mobile states directly, keeping automated browser E2E suites lean because of their runtime and flake cost.
- **Rust unit, integration & CLI suites (`cargo nextest` + `cargo test --doc`):** Consolidate integration tests under a single `tests/integration/main.rs` target (avoiding per-file `tests/*.rs` link bloat), exercise CLIs via `CARGO_BIN_EXE_<name>`, isolate state with `tempfile::TempDir`, and pair `cargo nextest run` with `cargo test --doc` when crates carry rustdoc examples (`nextest` does not execute doctests).
- **Nushell scripts (`std/assert`):** Built-in `use std/assert` (`assert equal`, `assert str contains`).
- **Opt-in snapshots & property checks:**
  - **CLI, parser & diagnostic snapshots (`insta` in Rust; `t.assert.snapshot` / `toMatchInlineSnapshot` in TS):** High-signal when formatted CLI transcripts, compiler/parser trees, or error diagnostics *are* the user contract (keeping scenarios readable inline); avoid snapshotting large internal structs or volatile fields that churn on benign edits.
  - **Property-based checks (`proptest` / `fast-check`):** Worth opting into for codecs, parsers, CRDTs, and state machines where edge cases hide in input combinations.

## 3. Anti-Vacuity, Determinism & Honest Failures

- **Test real behavior, never source substrings:** Assert on returned `Result` values, persisted SQLite/filesystem state, exit codes, HTTP responses, or rendered DOM — never write pseudo-tests that grep source files to check that code was edited. Use fixture values distinct from fallback defaults so broken fallback branches cannot pass green, and watch new regression tests fail against the unfixed bug first.
- **Hermetic state & deterministic clocks:** Isolate filesystem/config state in memory or temp directories via injected path roots or child-process `Command::env` `XDG_*` overrides (avoiding live `~/.config` / `~/.local/state` and Rust Edition 2024's `unsafe` in-process `std::env::set_var`), and drive timers deterministically (`t.mock.timers`, `vi.useFakeTimers()`, `tokio::time::pause()`) instead of `sleep()` loops.
- **Treat failures as signals:** Diagnose why a check failed or flaked before touching expectations. Never delete, skip, or weaken an existing test to get green without explicit owner approval, and distinguish executed test runs from static source inspection when reporting status.

> Related: `skill:bdd` for negotiating user-observable scenarios in `specs/*.feature`, and [[Testing]] for glossary and stack details.
