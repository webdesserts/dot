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

### `job spawn` is invisible to Claude Code's task tracker

**There is no notification path when a `job spawn` task completes.** Claude Code's harness only tracks background tasks dispatched through `Bash` (with `run_in_background: true`), the `Agent` tool, or `Monitor`. A nushell `job spawn` runs entirely inside the nushell MCP process — Claude Code doesn't see it start, finish, or fail, and the user can't see it in the UI either. If you `job spawn` something you intend to wait on, you have to poll for completion via `task X status` (or similar) yourself.

This is fine for fire-and-forget side work (kick off a build in the background while you continue editing). It is NOT fine for "wait until cycle X finishes and then act on the result" — pick one of these instead:

- **`Bash` with `run_in_background: true`** — surfaced in the UI, emits a completion task-notification with the output file path. The native way to await a single long-running command.
- **`Monitor` tool** — emits a chat notification on every matching stdout line. Use for "tell me when state transitions" (`until ! task X status | grep -q "running"; do sleep 5; done; echo done`) or "emit each event from a log stream."
- **Direct blocking call** — just invoke the command via `mcp__nu__evaluate` without backgrounding it. The tool call blocks until the command exits. Simpler than backgrounding when you have nothing else to do in parallel.

**Anti-pattern to avoid:** `job spawn { task review run --wait }`. The `--wait` flag already makes the command block until the cycle converges — backgrounding it inside `job spawn` loses both the synchronous return value AND any chance of a notification. Either run `task review run --wait` directly (blocks, returns verdict in exit code) or `task review run` + Monitor on the state file (parallel, notification on transition).

## Common Gotchas

- `job recv` does NOT take a job ID — it reads from the *current* job's mailbox only
- `job send` always requires a target job ID (main thread is `0`)
- There is no `job ls` — use `job list`
- Use `char escape`, `char newline`, `char tab` instead of `\e`, `\n`, `\t` escape sequences
- `glob` is the right tool for finding files — avoid `find` or recursive `ls`

---

> For nushell plugin development (nu-plugin crate, dual-use CLI pattern) and known issues, see [[Nushell]]
