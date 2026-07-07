---
name: rust
description: "Rust best practices and conventions. Use when writing or reviewing Rust code, working in .rs files, or discussing ownership, error handling, or Rust patterns."
---

## Error Handling

- **Library code**: Use `thiserror` for defining error types with meaningful variants. Each variant should carry enough context to diagnose the issue.
- **Application code**: Use `anyhow` for ad-hoc error propagation with context via `.context()`.
- **Avoid `.unwrap()`** in library code — use `?` operator or explicit error handling. `.unwrap()` is acceptable in tests and quick prototypes.
- **Avoid `.expect()` with vague messages** — if you must panic, the message should explain *why* the invariant should hold.

## Result and Option Chaining

Prefer chaining combinators over nested `match` statements when the logic is linear:

```rust
// ✅ Clear chain
let name = config.get("user")
    .and_then(|u| u.get("name"))
    .map(|n| n.to_uppercase())
    .unwrap_or_default();

// ❌ Deeply nested matches for the same logic
```

But use `match` when you need to handle multiple branches with different logic — don't force everything into a chain.

## Ownership Patterns

- **Prefer borrowing over cloning** — pass `&T` or `&mut T` unless you need ownership transfer
- **Use `Clone` judiciously** — cloning is fine for small types or when the alternative is complex lifetime annotations that hurt readability
- **Prefer `impl Trait` in function signatures** over concrete types for flexibility

## Clippy

Run `cargo clippy` and treat warnings as errors. Clippy catches common mistakes and suggests idiomatic patterns. If a lint is genuinely wrong for your case, use `#[allow(clippy::...)]` with a comment explaining why.

---

> For concurrency primitives (Box/Rc/Arc/RefCell/Cell/Mutex, channels, function traits Fn/FnMut/FnOnce), see [[Rust]]
