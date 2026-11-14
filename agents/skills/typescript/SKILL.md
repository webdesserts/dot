---
name: typescript
description: "TypeScript conventions, modeling tradeoffs, and tooling (Node 26+ native TS, @webdesserts/result, Pure Oxc). Use when writing or reviewing .ts/.tsx code or library APIs."
---

# TypeScript

Our TypeScript defaults optimize for **signatures that tell the truth at runtime** under Node `26+` native type-stripping (`erasableSyntaxOnly: true`), where types erase directly without codegen — avoid `enum`, runtime `namespace`, and constructor parameter properties (`constructor(private readonly x: T)` fails `TS1294` and `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`; declare explicit class fields and `as const` union objects instead).

## 1. Explicit `Result<T, E>` vs. Exceptions (`@webdesserts/result`)

Throwing exceptions creates invisible control flow that TypeScript cannot track (`catch (err: unknown)`), making recoverable failures look identical to bugs.

- **Owned module & library boundaries:** Model expected domain, validation, parsing, and I/O failures in return types using `@webdesserts/result` (`Result<T, E>`, `Result.ok`, `Result.err`, `Result.gen` / `Result.genAsync`, or plain `{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }` unions in zero-dep packages) so callers handle or propagate failure explicitly.
- **Where the tradeoff flips (throwing platform/framework edges):** Built-in and third-party APIs (`JSON.parse`, `node:fs`, `fetch`, test assertions) throw. Wrap throwing calls narrowly right at the boundary (`Result.try`, `Result.tryAsync`, `Result.wrap` — or prefer non-throwing `URL.parse(raw)` -> `URL | null` over `new URL(raw)`) rather than wrapping multi-step business logic in broad `try / catch` pyramids.
- **Invariant escape hatches:** When a failure branch is unreachable by construction, prefer `.expect("invariant: <why>")` (or `.unwrap()` in tests) over silent fallback defaults so assumptions remain greppable (`rg '\.(unwrap|expect)\('`). Extend `Error` with structured `readonly` fields when rich diagnostic context matters.

## 2. Sound Narrowing Over `any` and `as T` Assertions

Type assertions (`x as Foo`) silence the compiler without validating data at runtime, turning boundary drift into delayed `TypeError`s.

- **Untrusted inputs (`unknown` -> predicates):** Treat parsed JSON, IPC payloads, CLI flags, and network responses as `unknown`, narrowing via custom type guards (`x is Subtype`), assertion functions (`asserts x is Subtype`), or schema validators.
- **Discriminated unions & compiler inference:** Use `as const satisfies Schema` to check shapes without widening literals, exhaustive `switch` (`const _: never = x`) so added variants fail compilation, inferred array predicates (`.filter((r) => r.ok)` in `TS 5.5+`), and `NoInfer<T>` on fallback arguments (`unwrapOr<T>(r: Result<T>, fallback: NoInfer<T>)`).
- **Wide-default generics (`<T extends Wide = Wide>`):** Give generic containers domain-meaningful wide defaults (`interface Document<T extends JsonObject = JsonObject> { readonly data: T }`, using `= unknown` only for unconstrained top types like `Result<T = unknown, E = Error>`). Bare `Document` stays usable without casts, specializations (`Document<UserJson>`) enforce bounds, and `readonly` covariant fields keep specialized values assignable back to the wide base type.

## 3. State Encapsulation, Immutability & Explicit Dependencies

- **Stateful handles + pure transforms:** Encapsulate lifecycles, sockets, DB handles, and caches inside classes with `#private` fields, while keeping domain logic and data transformations as pure `(input) -> output` functions that are trivial to test directly.
- **`readonly` by default:** Prefer `readonly` properties, `readonly T[]`, `ReadonlyMap`, and `ReadonlySet` across interfaces and state transitions; keep mutation local to bounded accumulators or measured hot paths. Associate external metadata or caches with object identity via `WeakMap` (`.getOrInsertComputed(key, compute)` on ES2026 / Node `26+`) rather than mutating foreign objects.
- **Explicit dependency injection:** Pass clocks, filesystems, transports, and loggers via constructors or options parameters instead of mutable module singletons so tests stay fast and hermetic without module monkey-patching.

## 4. Tooling & In-Repo Library Docs

- **Pure Oxc (`oxfmt` + `oxlint` `typeAware: true`):** Default TypeScript libraries to `oxfmt` (formatting + import/package sorting) and `oxlint` with `options.typeAware: true` (`oxlint-tsgolint`) and `denyWarnings: true` — mechanically catching `no-explicit-any`, `consistent-type-assertions` (`assertionStyle: "never"`, allowing `as const`), `switch-exhaustiveness-check`, `no-floating-promises`, and `import/no-cycle`.
- **Single-source-of-truth docs:** Keep root `README.md` focused on what the package solves, installation, and quickstart, with detailed public interface docs in `docs/api/*.md` covering strictly exported symbols. Keep API references in the repo rather than duplicating them into external notes where they can drift.

> Deeper reference (Node native type-stripping flags, `@types/node` assertion narrowing gotchas, `generateTrace` profiling): see [[TypeScript]].
