# Claude Code Memory System Documentation

## How Claude Code Memory Works

Claude Code uses a **hierarchical memory system** where files are automatically loaded when Claude Code launches:

### Memory Hierarchy (Precedence Order)

1. **Enterprise Policy Memory** (System-wide)
2. **Project Memory** (`./CLAUDE.md`) - Team-shared project instructions
3. **User Memory** (`~/.claude/CLAUDE.md`) - Personal preferences across ALL projects
4. **Local Project Memory** (`./CLAUDE.local.md`) - Personal notes for current project

### Key Behaviors

- **Higher-level memories take precedence** - project memories override user memories
- **All memory files are automatically loaded** when Claude Code launches
- **Files can import other files** using `@path/to/import` syntax (max 5 hops deep)
- **Maximum import depth**: 5 hops to prevent circular references

### File Purposes

- **`~/.claude/CLAUDE.md`**: Personal workflow preferences across ALL projects
- **`~/code/{company}/CLAUDE.md`**: Company/organization-specific conventions (e.g., `~/code/spatialkey/CLAUDE.md`)
  - Applies to all projects under that company directory
  - Git conventions, company tools, team practices
  - Not in git - managed via dotfiles
- **`./CLAUDE.md`**: Project-specific context, team conventions (can be gitignored or shared)
- **`./CLAUDE.local.md`**: Personal working notes for current project (git-ignored)
- **`TODO.md`**: Task management only (separate from memory system)

---

## Obsidian Memory

**Search notes before answering questions.** When the user asks about ANY topic, check if information exists in notes first before relying on training data.

- Use `get_note()` to check if a topic has a note, then Read the file path to view content
- Use `get_graph_neighborhood()` to find related notes and explore connections
- Trust note content over training data when they conflict

**Session Log:** The log tracks chronological session activity. Use the `log()` tool to append entries (timestamps added automatically).

@/Users/michael/notes/Log.md

**Notetaking instructions:**

@~/.dots/webdesserts-private/claude/plugins/obsidian-memory/instructions/notetaking.md

---

## Settings and Permissions

**Documentation**: https://docs.claude.com/en/docs/claude-code/settings

### Settings Files

- **`~/.claude/settings.json`**: Global permissions across ALL projects (user-specific)
- **`./.claude/settings.json`**: Project-specific permissions shared with team (can be committed to git)
- **`./.claude/settings.local.json`**: Project-specific user overrides (git-ignored, takes precedence over team settings)

### Permission Types

- **`allow`**: No approval needed
- **`ask`**: Requires user approval
- **`deny`**: Blocked entirely

### Common Patterns

**Local operations (allowed):**

- `Bash(git commit:*)`, `Bash(git add:*)` - local git operations
- `Read(//path/**)` - reading files
- `Bash(yarn test:*)` - running tests

**Team-visible operations (require approval):**

- `Bash(git push:*)` - pushing to remote
- `Bash(git rebase:*)`, `Bash(git commit --amend:*)`, `Bash(git reset:*)` - git history changes
- `Bash(acli bitbucket pr create:*)` - creating PRs
- `Bash(acli jira issue create:*)`, `Bash(acli jira issue update:*)` - creating/updating tickets

---

# Generic Workflow Guidelines

## Commit Workflow - VERY IMPORTANT

When making commits, follow these rules:

### Commit Message Format

- **Keep subject lines short and clear** - Describe what changed, not why
- **Use extra description sparingly** - Only add detail when explaining bugs or linking important context
- **No paragraphs** - Keep description concise, a few lines at most
- **NEVER add attribution lines** - Do NOT include any of these:
  - "Co-Authored-By: Claude <noreply@anthropic.com>"
  - "Generated with [Claude Code](https://claude.com/claude-code)"
  - Any similar attribution or signature lines
- **Plain commit messages only** - Just the subject line and optional brief description, nothing else

### Git Safety Rules

- **NEVER push without permission** - Always ask before pushing to remote
- **NEVER force push to main/master** - Warn user if they request it
- **NEVER skip hooks** - Don't use --no-verify, --no-gpg-sign, etc. unless explicitly requested
- **NEVER amend other developers' commits** - Only amend your own most recent commit if needed

### Commit Strategy

- **Small, standalone commits** - Break work into logical units that can be reviewed independently
- **Atomic changes** - Each commit should be a complete, working change
- **Clean history** - Enables easy rollback and clear project evolution

### Example Workflow:

```
Task: Implement local storage utilities
✅ DO: Break into logical commits (utils → component → integration)
❌ DON'T: Single massive commit with everything at once
```

### Why This Matters

- Enables easy rollback of individual changes
- Creates clean, navigable git history
- Makes code review more effective
- Allows bisecting to find when bugs were introduced

## Implementation Approach - CRITICAL

### Major Design Decisions Require Approval

- **Never drastically diverge** from the original implementation approach without explicit user approval
- **Small technical decisions** (variable names, minor refactoring) are fine to make independently
- **Major architectural changes** (completely different API design, alternative solutions) require sync

### When to Sync with User

✅ **OK to decide independently:**

- Method/variable naming
- Minor refactoring for clarity
- Small bug fixes
- Code organization improvements

❌ **Must get approval first:**

- Changing from suggested API design to completely different approach
- Adding/removing major features from the original plan
- Using different libraries/patterns than discussed
- Abandoning complex solutions for simpler alternatives without discussion

### If You Encounter Technical Blockers

1. **First**: Try to solve within the original approach
2. **Document**: What specific issue you encountered
3. **Propose**: Multiple alternatives with clear pros/cons for collaborative decision-making
4. **Wait**: For user decision before implementing alternative
5. **Never**: Just switch to different approach due to complexity

**Collaborative problem-solving**: When technical issues arise, present options rather than switching approaches unilaterally. The user may have insights or preferences that inform the best solution.

### Example Decision Points

```
❌ "Complex type inference is hard, so I'll make simple helper functions instead"
✅ "Complex type inference hit X technical issue. Options: A) Simpler helpers B) Different approach C) Solve complexity. Which do you prefer?"
```

## Development Principles

### Code Reuse and Discovery

- **Search before creating**: Always look for existing types, utilities, and patterns before implementing new ones
- **Reuse existing code**: Prefer extending or using existing solutions over creating duplicates

## TypeScript Best Practices

### Type Safety Guidelines

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

### Modern TypeScript Features

- **Use `satisfies`**: For better type inference while maintaining type checking
  ```typescript
  // ✅ Better type inference
  const config = { theme: "dark", version: 1 } as const satisfies Config;
  ```
- **Minimize type casting**: Design better types instead of casting
- **Use template literal types**: For string literal unions and type-safe keys

### Error Handling

- **Use proper Error classes**: Always extend `Error` for custom error types
  ```typescript
  // ✅ Proper error classes
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

### Data Validation

- **Use `unknown` for external data**: Always treat external data as `unknown` first
- **Type guards over casting**: Create proper type guard functions
  ```typescript
  function isString(value: unknown): value is string {
    return typeof value === "string";
  }
  ```

## Testing Guidelines (Cucumber-Inspired Style)

### Structure and Organization

- **`describe()` blocks**: Focus on developer use cases and business scenarios, not just class/method names
- **Group by behavior**: Organize tests around what the user/developer is trying to accomplish
- **Nested contexts**: Use nested `describe()` blocks to set up different scenarios/contexts

### Naming Conventions

```typescript
describe("UserStore", () => {
  describe("new UserStore()", () => {
    it("should create a new UserStore", () => {
      // Constructor behavior
    });
  });

  describe("load()", () => {
    it("should load the user data", async () => {
      // Happy path behavior
    });

    it("should only update once when called multiple times", async () => {
      // Edge case behavior
    });
  });
});
```

### Context-Driven Testing

- **Use scenario-based describes**: "If one does not exist", "If one DOES exist", "With a variable number of..."
- **Focus on user intentions**: What is the developer trying to accomplish?
- **Test business rules**: "should work like == when operation is 'equals'"

### Test Content Guidelines

- **Implementation-aware**: Tests can know about method names and internal structure (unlike pure BDD)
- **Multiple assertions per test**: OK to have several related expectations in one test
- **Use specific examples**: Test with concrete data that represents real scenarios
- **Edge cases matter**: Test null/undefined, empty arrays, error conditions

### Test Comment Guidelines

Test comments should add context that isn't obvious from the test structure:

✅ **Valuable test comments:**

- Explain what changes/behaviors the test is specifically verifying
- Highlight edge cases or non-obvious scenarios being tested
- Clarify business rules or domain concepts being validated
  ```typescript
  themePreference: z.enum(["light", "dark"]).default("light"), // Field renamed from 'theme'
    expect(result.value.themePreference).toBe("dark"); // theme -> themePreference migration
  ```

❌ **Avoid these test comments:**

- Restating obvious test names or describe blocks
- Explaining basic language constructs
- Over-commenting self-explanatory assertions

### Good Examples

```typescript
// Scenario-based organization
describe(`If one does not exist`, () => {
  it("creates a new one", () => {
    // Test creation logic
  });
});

describe(`If one DOES exist`, () => {
  it("should restore the previous state", () => {
    // Test restoration logic
  });
});

// Business rule testing
describe(`when filter type is numeric`, () => {
  it('should work like >= when the operation is "greaterThanEqualTo"', () => {
    // Multiple specific test cases
  });
});
```

### Setup and Mocking

- Use `beforeEach()` for consistent test setup
- Mock at the service/environment level when testing stores
- Create realistic test data that mirrors production scenarios

## Developer-Focused Documentation Standards

All code comments and documentation should be written for **mid-level developers** who:

- Know the product and business domain
- Are new to this specific section of the codebase
- Need to understand both "what" and "why" to effectively maintain the code

### Readable Code First

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

### Comment Guidelines

#### Target Audience

- **Write for colleagues**, not yourself or other implementers
- **Assume product knowledge** but not intimate code familiarity
- **Assume language fluency**: Don't explain basic language concepts (e.g., don't explain what a TypeScript `type` is to TypeScript developers)
- **Explain intent and edge cases**, not just mechanics
- **Document decisions and tradeoffs** that weren't obvious

#### Special Comment Types

- **`~rev:` comments**: These are temporary code review comments that should be **read and immediately deleted** as you address them. Treat them like inline code review feedback that needs action.

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

#### Required Documentation

- **Hacks must be marked**: Always explicitly label workarounds or temporary solutions

  ```typescript
  // HACK: Working around React 18 batching issue - remove when React fixes upstream
  flushSync(() => updateState(newValue));
  ```

- **Complex code needs explanation**: Types, regexes, algorithms, and math should explain:
  - What the code accomplishes
  - Edge cases being handled
  - Why this approach was chosen
  ```typescript
  // Recursive type that finds schema by version number using pattern matching
  // Handles empty tuples (returns never) and searches through tuple until match found
  type FindSchemaByVersion<V extends number, Schemas extends VersionedSchemaList> = ...
  ```

#### Comment Maintenance

**Keep comments synchronized with code changes:**

- For every diff that changes the content of a function, **revisit that function's comments**
- Update or remove comments that no longer accurately describe the code
- Add new comments if the change introduces complexity that needs explanation

#### Comment Style

- **Explain the "why"** behind non-obvious decisions
- **Document edge cases** and assumptions
- **Use business language** when explaining domain concepts
- **Avoid implementation-specific jargon** unless necessary for understanding
- **Prioritize "what this does"** over "how this works internally" - especially for types and utilities

  ```typescript
  // ❌ Implementation-focused
  // Recursive type that uses pattern matching to search through tuple elements

  // ✅ Function-focused
  // Gets the last version in a list of schemas
  ```

#### Documentation Depth Guidelines

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

#### IDE Experience Optimization

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

### Documentation Red Flags

❌ **Avoid these patterns:**

- Persistent comments directed at specific people ("MM thinks we should..." or "Ask John about this")
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

## Dotfile Management

**Tool**: `dots` CLI - https://github.com/webdesserts/dots-cli

**IMPORTANT**: Always run `dots --help` or check the GitHub README before using commands. Your knowledge may be outdated.

### Basic Usage

```bash
# List all installed dots
dots list

# Preview changes before applying
dots install --dry

# Install/update symlinks from Dot.toml files
dots install

# Check git status of all dots
dots status

# Get path to a specific dot
dots path <dot-name>
```

### Structure

- **`~/.dots/`** - Root directory for all dotfile repos
- **`dot-footprint.toml`** - Master list of all symlinks (auto-generated)
- **Individual dots** - Each has a `Dot.toml` defining links

### Current Dots

- **velvet** - Neovim configuration
- **webdesserts** - Public dotfiles (shell, git, scripts, vscode)
- **webdesserts-private** - Private dotfiles (ssh, work scripts, credentials)

### Link Format in Dot.toml

```toml
[link]
"~/destination/path" = "source/file/in/repo"
```

## Remember

**NEVER PUSH** without explicit user permission!
**ALWAYS SYNC** before making major architectural decisions or diverging from original approach!
**KEEP COMMITS CLEAN** - short messages, no co-author attribution, minimal description text!
