---
name: rust
description: "Rust conventions, crate selection, and modeling tradeoffs (rustc 1.100+ / Edition 2024). Use when writing or reviewing .rs files, Cargo.toml dependencies, error types, or XDG paths."
---

# Rust (`Edition 2024`, `rustc 1.100+`)

We favor **explicit domain types and one well-maintained crate per problem** (vetted for active maintenance and contributor bus-factor) so workspaces stay fast to compile, predictable across macOS and Linux, and easy to maintain long-term.

## 1. Error Modeling: Typed Contracts vs. Erasure

Erasing errors into `anyhow::Error` inside library or daemon modules hides failure modes from function signatures and prevents callers from matching recoverable cases (`NotFound`, `Locked`, `InvalidInput`). Match the error representation to who consumes it:

- **`thiserror` (`2.x`) — default for library, domain, and daemon modules:** Zero runtime overhead, `#![no_std]` support, and explicit per-module error enums where each variant carries actionable context and `#[source]` chains.
- **Manual `core::error::Error` + `Display`:** Worth choosing over `thiserror` only in zero-proc-macro `#![no_std]` or WASM leaf crates where avoiding `syn` compile time outweighs derive ergonomics.
- **`snafu` (`0.9`) — large typed-enum crates:** Useful when rich call-site context selectors (`ensure!`, `.context(ReadConfigSnafu { path })`) eliminate repetitive `.map_err(...)` boilerplate across multi-step I/O.
- **`miette` (`7.x`) — human-facing CLI, config, and parser diagnostics:** Layers source spans, labels, and help hints (`#[derive(thiserror::Error, miette::Diagnostic)]`) onto concrete module error enums so library callers keep typed variants while CLI entrypoints convert via `?` into `fn main() -> miette::Result<()>` (`miette::Report`) at the top boundary.
- **`anyhow` (`1.x`) — scripts, spikes, and test helpers only:** Convenient when rapid prototyping or test setup only needs `.context("...")` and no caller ever inspects error variants.
- **Panics & invariants:** Avoid `.unwrap()` outside tests; when an invariant genuinely holds by construction, `.expect("invariant: <why>")` documents the assumption for future readers and crash logs.

## 2. Config, State & Filesystem Paths (XDG Consistency)

Popular path crates (`dirs`, `directories`) route macOS apps to `~/Library/Application Support` and ignore `$XDG_CONFIG_HOME`, splitting CLI/dotfile layouts between macOS and Linux and breaking hermetic `$XDG_*` test overrides.

- **First-party apps & daemons:** Use **`webdesserts/app-config`**, which enforces `~/.config/<app>/` and `~/.local/state/<app>/` (`0700` dirs, `0600` files) with symlink-safe atomic writes across macOS and Linux.
- **Standalone Rust CLIs & crates:** Use **`etcetera` (`0.11`)** (`choose_base_strategy()`) so both macOS and Linux honor XDG base directories (`~/.config`, `~/.local/state`, `~/.cache`).
- **Home, temp & hermetic test paths:** `std::env::home_dir()` is un-deprecated and fixed since Rust `1.85` when only `$HOME` is needed; use **`tempfile` (`3.x`)** (`TempDir`, `NamedTempFile`) for isolated test state. Because `std::env::set_var` / `remove_var` are `unsafe` in Edition 2024 (process-wide UB under multi-threaded test runners), pass `XDG_*` overrides on child CLI processes via `Command::env` or inject explicit config/state root paths into constructors.

## 3. Ownership, Control Flow & Clippy

- **Borrow at boundaries, clone pragmatically:** Accept borrowed views (`&str`, `&[T]`, `&Path`, `impl AsRef<Path>`) in parameters so callers control allocation. Prefer borrowing over reflexive `.clone()`, while cloning cheap handles (`Arc<T>`, `Copy`/small IDs) freely when complex lifetimes would obscure straightforward control flow.
- **Linear chains, `let` chains & explicit `match`:** Use `let ... else { return ... }`, Edition 2024 `let` chains (`if let Some(a) = x && let Ok(b) = parse(a)`), and Option/Result combinators (`.and_then`, `.map`, `?`) when data flows linearly; switch to `match` as soon as multiple branches carry distinct domain logic. (Other Edition 2024 shifts: `gen` is a reserved keyword, `std::env::{set_var, remove_var}` require `unsafe`, and `impl Trait` return types capture in-scope lifetimes by default — write `+ use<...>` to restrict capture.)
- **Clippy & lint expectations:** Treat `cargo clippy --all-targets` warnings as design feedback. When a lint is genuinely counterproductive for a specific item, prefer `#[expect(clippy::..., reason = "...")]` (Rust `1.81+`) over `#[allow(...)]` so the compiler warns if later refactors make the suppression obsolete.

> Deeper reference (smart pointers, interior mutability, async/Tokio patterns, error crate tradeoffs): see [[Rust]] and [[Rust Error Handling]].
