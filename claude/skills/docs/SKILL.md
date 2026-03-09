---
name: docs
description: "Documentation, code comments, and JSDoc standards. Use when writing or reviewing documentation, inline comments, JSDoc, or any prose in code. Also use when cleaning up, improving, or evaluating comment quality."
---

## Target Audience

All code comments and documentation should be written for **mid-level developers** who:

- Know the product and business domain
- Are new to this specific section of the codebase
- Need to understand both "what" and "why" to effectively maintain the code

## Readable Code First

**Always prefer readable code over excess comments** when possible:

- Use descriptive variable and function names
- Break complex operations into smaller, well-named functions
- Structure code to be self-documenting
- **Only add comments** when they provide context and motivation that cannot be expressed clearly through code alone

```typescript
// ❌ Over-commented obvious code
const users = data.filter((item) => item.type === "user"); // Filter for users only

// ✅ Self-documenting code, no comment needed
const users = data.filter((item) => item.type === "user");

// ✅ Comment adds valuable context
const users = data.filter((item) => item.type === "user"); // Exclude admin accounts per security requirements
```

## Comment Guidelines

### Writing Style

- **Write for colleagues**, not yourself or other implementers
- **Assume product knowledge** but not intimate code familiarity
- **Assume language fluency**: Don't explain basic language concepts (e.g., don't explain what a TypeScript `type` is to TypeScript developers)
- **Explain intent and edge cases**, not just mechanics
- **Document decisions and tradeoffs** that weren't obvious

### Comment Style

- **Explain the "why"** behind non-obvious decisions
- **Document edge cases** and assumptions
- **Use business language** when explaining domain concepts
- **Avoid implementation-specific jargon** unless necessary for understanding
- **Prioritize "what this does"** over "how this works internally" — especially for types and utilities

```typescript
// ❌ Implementation-focused
// Recursive type that uses pattern matching to search through tuple elements

// ✅ Function-focused
// Gets the last version in a list of schemas
```

### Special Comment Types

- **`~rev:` comments**: Temporary code review comments that should be **read and immediately deleted** as you address them. Treat them like inline code review feedback that needs action.

  ```typescript
  // ~rev: What's the use case for this function? It's not clear from the documentation.
  ```

- **Implementation detail comments**: OK to include when:
  - The implementation is unique or non-standard
  - External library context drives the exposed API design
  - The API doesn't make sense without implementation context
  ```typescript
  // Zod requires explicit version literals for discriminated unions to work properly,
  // so we enforce z.literal(N) instead of z.number() for version fields
  ```

### Required Documentation

- **Hacks must be marked**: Always explicitly label workarounds or temporary solutions

  ```typescript
  // HACK: Working around React 18 batching issue - remove when React fixes upstream
  flushSync(() => updateState(newValue));
  ```

- **Complex code needs explanation**: Types, regexes, algorithms, and math should explain:
  - What the code accomplishes
  - Edge cases being handled
  - Why this approach was chosen

### Comment Maintenance

**Keep comments synchronized with code changes:**

- For every diff that changes the content of a function, **revisit that function's comments**
- Update or remove comments that no longer accurately describe the code
- Add new comments if the change introduces complexity that needs explanation

## Documentation Depth Guidelines

Adjust documentation level based on code usage and complexity:

**Widely-used APIs and types** (exported, used across multiple files):

- Always include clear descriptions even for simple concepts
- Provide usage examples when helpful
- Document expected behavior and edge cases

**Internal helpers and utilities** (single file or limited scope):

- Minimal documentation for self-explanatory code
- Focus on non-obvious behavior or constraints
- Document only when it adds value beyond the code itself

**Complex implementations** (algorithms, type gymnastics, business logic):

- Always document regardless of scope
- Explain both "what" and "why"
- Include examples for non-trivial usage

**Export management**: Only export what external code actually needs. Remove exports that aren't used outside their defining module to keep the public API surface intentional and focused.

## IDE Experience Optimization

Place documentation where developers will encounter it in their development environment:

- **JSDoc on classes and functions**: Provides hover documentation in IDEs
- **Attach examples to the main class/function**: Rather than file headers, put usage examples in JSDoc so they appear in IntelliSense

  ```typescript
  // ❌ Documentation separate from class
  // See file header for SchemaVersions usage examples...
  export class SchemaVersions {}

  // ✅ Documentation attached to class
  /**
   * Type-safe schema versioning for evolving data structures
   *
   * @example
   * const userSettings = SchemaVersions.add(UserSettingsV1Schema)
   *   .add(UserSettingsV2Schema, migrateV1toV2);
   */
  export class SchemaVersions {}
  ```

## Documentation Red Flags

❌ **Avoid these patterns:**

- Persistent comments directed at specific people
- Implementation details without business context
- Obvious statements that don't add value
- Outdated comments that no longer match code
- Over-commenting self-explanatory code

✅ **Prefer these patterns:**

- Business context and reasoning
- Edge case explanations
- Integration guidance for other developers
- Clear examples of intended usage
- Comments that add context not obvious from code
- Temporary `~rev:` comments that get addressed and removed
