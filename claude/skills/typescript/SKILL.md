---
name: typescript
description: "TypeScript best practices and conventions. Use when writing or reviewing TypeScript code, working in .ts/.tsx files, or discussing type safety."
---

## Type Safety Guidelines

- **Avoid `any`**: Use `unknown` for truly unknown data or specific types when possible
- **Minimize `null`/`undefined`**: Use optional properties with defaults instead

  ```typescript
  // ❌ Avoid
  let value: string | null = null;

  // ✅ Prefer
  interface Config {
    theme?: "light" | "dark";
  }
  const config: Config = { theme: "light" }; // with default
  ```

## Modern TypeScript Features

- **Use `satisfies`**: For better type inference while maintaining type checking
  ```typescript
  // ✅ Better type inference
  const config = { theme: "dark", version: 1 } as const satisfies Config;
  ```
- **Minimize type casting**: Design better types instead of casting
- **Use template literal types**: For string literal unions and type-safe keys

## Error Handling

- **Use proper Error classes**: Always extend `Error` for custom error types
  ```typescript
  class ValidationError extends Error {
    constructor(public readonly details: string) {
      super(`Validation failed: ${details}`);
      this.name = "ValidationError";
    }
  }
  ```
- **Leverage Result type**: Use the existing Result utility for explicit error handling
  ```typescript
  function parseData(input: unknown): Result<ParsedData, ValidationError>;
  ```

## Data Validation

- **Use `unknown` for external data**: Always treat external data as `unknown` first
- **Type guards over casting**: Create proper type guard functions
  ```typescript
  function isString(value: unknown): value is string {
    return typeof value === "string";
  }
  ```

---

> For deeper TypeScript knowledge (performance profiling with `generateTrace`, structural typing details), see [[TypeScript]]
