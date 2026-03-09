---
name: nushell
description: "Nushell idioms and patterns. Use when executing shell commands, writing scripts, editing .nu files, or any terminal operation."
---

## Core Principles

Nushell works with **structured data**, not text streams. Prefer native nushell commands over external commands because they return tables, records, and lists — not raw strings.

- Use `ls` instead of `find` or `ls -R`
- Use `glob` for file pattern matching
- Use `ps` for process listing
- Use `sys` for system info
- Use `open` instead of `cat`

## Pipeline Patterns

Nushell pipelines pass structured data between commands:

```nu
# Filter and transform structured data
ls **/*.rs | where size > 1kb | sort-by modified | select name size

# Prefer par-each for parallel processing
ls **/*.rs | par-each { |f| wc -l $f.name }
```

**Use `par-each` over `each`** for better performance on I/O or CPU-bound work. Only use `each` when order must be preserved or side effects must be sequential.

## String Interpolation

Variables and expressions **must** be in parentheses inside `$"..."` strings:

```nu
# ❌ Regular strings don't interpolate
let name = "world"; echo "hello $name"       # Prints literal: hello $name

# ✅ Use $"..." with parentheses
let name = "world"; echo $"hello ($name)"    # Prints: hello world
```

**Command-line flags with variables** — the entire flag must be an interpolated string:

```nu
# ❌ Mixing styles
mysql -p"$env.DATABASE_PASSWORD" mydb

# ✅ Entire flag as interpolated string
mysql $"-p($env.DATABASE_PASSWORD)" mydb
```

## Stderr Redirection

Use `o+e>` instead of bash-style `2>&1`:

```nu
# ❌ Bash syntax doesn't work
command 2>&1

# ✅ Nushell redirection
command o+e>| other_command    # Redirect stderr to stdout, pipe
command o+e>| ignore           # Discard both stdout and stderr
```

## ANSI Handling

Use `ansi strip` to remove ANSI color codes. Do NOT use `\u001b` or unicode escapes — nushell doesn't support that syntax:

```nu
# ✅ Strip ANSI from output
^rg pattern | ansi strip
```

## Background Jobs

Use `job spawn` instead of bash `&`:

```nu
job spawn { sleep 5sec; echo "done" }    # Returns job ID
job list                                   # List running jobs
job kill 1                                 # Kill by ID
```

For getting results back, use the mailbox system:

```nu
job spawn { ls | job send 0 }    # Send to main thread (ID 0)
job recv                          # Receive in main thread
```

## Common Gotchas

- `job recv` does NOT take a job ID — it reads from the *current* job's mailbox only
- `job send` always requires a target job ID (main thread is `0`)
- There is no `job ls` — use `job list`
- Use `char escape`, `char newline`, `char tab` instead of `\e`, `\n`, `\t` escape sequences
- `glob` is the right tool for finding files — avoid `find` or recursive `ls`

---

> For nushell plugin development (nu-plugin crate, dual-use CLI pattern) and known issues, see [[Nushell]]
