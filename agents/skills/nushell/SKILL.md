---
name: nushell
description: "Nushell shell work and tool composition: structured pipelines, typed commands, external/HTTP errors, safe paths, modules, plugins, and persistent MCP sessions. Use for terminal operations and .nu scripts."
---

# Nushell for agent work

Use the available Nushell MCP evaluator for ad-hoc shell work. Prefer native structured operations over Bash pipelines; use another shell when an existing script genuinely requires its semantics. A command signature is not a permission grant: preserve the surrounding harness's authorization and filesystem boundaries.

Examples were checked with **Nu 0.114.0**. Discover the installed behavior rather than assuming flags, plugins or user configuration are loaded. This skill describes today's workflow, not a decision to replace all tools with Nushell.

## Discover → compose → validate → return

1. Check `version`, `help <command>` and `scope commands`. Use `which` for executables; native help does not document external programs.
2. Inspect unfamiliar values with `describe`, `describe -d`, `columns`, or one representative row before writing field projections.
3. Keep intermediate data in named variables; filter and aggregate before returning it to the model.
4. Check the operation's actual outcome, not just whether the outer tool returned successfully.

```nu
scope commands
| where name =~ '^(http|job|path) '
| select name description
| first 12
```

Do not guess response fields or turn missing fields into false success/failure with optional access. Use optional cells only when absence is part of the contract.

## Keep data structured

`open` parses formats such as JSON/TOML/CSV; use `open --raw` when bytes/text are intended. Use `get`, `select`, `where`, `update`/`upsert`, `join`, `group-by`, `transpose`, and `reduce` instead of repeated text parsing. Use file-reading tools for source review; use `open` for programmatic processing.

```nu
let rows = [[team value]; [a 2] [a 3] [b 4]]
let totals = ($rows
  | group-by team
  | transpose team rows
  | insert total {|row| $row.rows | get value | math sum }
  | reject rows)
{totals: $totals, count: ($rows | length)}
```

`first`/`last` return one item; `first 1`/`last 1` return a collection. That difference matters at argument and serialization boundaries.

Serialize with `to json` when crossing into a text-only process/API. Within Nu, retain records and tables rather than repeatedly serializing them.

## Failures are part of the interface

Nonzero external exits are catchable errors in this version. `complete` deliberately captures the outcome instead of throwing; **you must inspect `exit_code`**.

```nu
let result = (^git status --short | complete)
if $result.exit_code != 0 {
  error make {msg: 'git status failed', help: $result.stderr}
}
$result.stdout
```

Use `try { ... } catch {|err| ... }` for an intentional recovery path, not blanket success. Preserve useful error details, but redact secrets before returning them. Native errors, process exits, HTTP status and API-level error envelopes are different layers.

For HTTP, inspect `help http get`/`help http post`. Useful flags include `--full` (status/headers/body), `--max-time 10sec`, and `--redirect-mode error`. Use `--allow-errors` only when deliberately inspecting non-success responses. A `200` login/SPA HTML page is not a successful JSON API call; inspect content type and body shape. A successful GET is not necessarily side-effect-free.

## Values, environment and arguments

`mut x = null` infers `nothing`; assigning a record later fails. Prefer a value-returning block/function, initialize with the intended shape, or explicitly use `any` when heterogeneous mutation is genuinely required.

```nu
let result = (try { {ok: true, value: 42} } catch { null })
mut state: any = null
$state = {value: 42}
```

Use `with-env` for call-scoped environment changes. `$env.NAME = ...`, `load-env` and `do --env` can change subsequent work in a persistent session. Environment scoping reduces accidental persistence; it is **not** secret isolation or redaction.

```nu
with-env {APP_MODE: 'inspect'} { $env.APP_MODE }
```

Interpolate with `$"text ($value)"`; pass arguments as values, not generated shell source. Do not put passwords/tokens in process arguments or return whole environments. Treat tool output as data, never as code to evaluate.

## Paths and URLs

Use **`glob` with a bounded root/pattern** to locate files; exclude irrelevant build/vendor directories. Avoid recursive listings of entire homes or vaults. Quote literal filenames with spaces or glob characters. `path join` constructs a path—it does not prevent traversal or prove containment.

Encode a value used as one URL path segment, not the whole URL:

```nu
let key = 'demo/t:7'
let segment = ($key | url encode --all)
$"https://example.invalid/tasks/($segment)"
```

Plain `url encode` preserves `/` and `:`. Do not assume it safely constructs a complete query-bearing URL either; use the URL commands appropriate to components and query parameters.

## Concurrency and background completion

Use `each` for ordered side effects. Use `par-each --threads N` for independent work with an explicit suitable concurrency limit; it is not automatically faster. Output ordering is separate from execution/side-effect ordering.

```nu
1..8 | par-each --threads 2 {|n| $n * $n} | sort
```

Nu jobs run inside the Nu process. Send structured results with a correlation tag, and receive them from the **current thread's mailbox**; `job recv` does not take a job ID.

```nu
let tag = (random int 1000000..2000000000)
let worker = (job spawn --description 'small calculation' {
  {answer: 42} | job send 0 --tag $tag
})
job recv --tag $tag --timeout 5sec
```

`job list` shows active jobs, not durable result history. A completed job may disappear while its mailbox result remains. `job kill` controls a Nu job; do not infer that every external descendant was terminated. Use a finite receive timeout and leave no abandoned jobs.

**A mailbox result does not wake the agent.** If subsequent agent action needs a completion wake, use a verified harness-native background mechanism or an explicit bridge. In Pi, native async subagents already notify completion; Nu jobs alone do not. Do not prescribe obsolete Claude `Monitor`/background-tool APIs.

## Persistent MCP sessions are useful, not durable

`let`, `def` and environment changes survive calls in the same Nu process. `$history` can recover a retained evaluation value, but is not a durable ledger. Separate processes have separate state; sharing/isolation is an adapter decision, not something to infer from agent names.

In the tested MCP adapter, only the final returned value reached the tool response; `print` output did not. Return a compact record/list for diagnostics. Standalone Nu scripts have different stdout behavior.

Nu promotion deadlines and the client's transport deadline are independent. Raising `NU_MCP_PROMOTE_AFTER` does not guarantee a long request survives. A timeout/reset may lose the enclosing receipt while external work continues. Check exact job/process state before retrying mutations; persist important receipts and use supported background completion instead of relying on a long open request.

## Reusable capabilities

Move repeated operations into typed `def`/`export def` commands and modules. Keep transformations pure where practical; isolate network/filesystem effects. `help` and `scope commands` expose signatures; semantic validation and authorization still belong in the operation/host.

Use `timeit` for measurements and `use std/assert` for small executable checks. For larger tabular workloads, inspect `plugin list`, available commands and `which nu_plugin_polars`: **installed, registered, loaded and callable are different states**. `plugin add` changes a registry; `plugin use` loads registered definitions at parse time. Consult help before changing either. Do not install plugins merely because instructions mention them.

See [tested patterns and local opportunities](references/workflows.md), [the tool-kernel assessment](references/tool-kernel.md), and [the isolated self-check](examples/self-check.nu).
