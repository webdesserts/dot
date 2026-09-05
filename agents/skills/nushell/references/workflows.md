# Tested workflows and local opportunities

Checked on umbra with Nu 0.114.0, 2026-09-05. This is a capability snapshot, not a claim about other machines or later sessions.

## Useful capabilities to reach for

| Need | Capability | Evidence / caveat |
|---|---|---|
| Inspect unfamiliar results | `describe -d`, `columns`, a representative row | Recursive value types and command metadata tested. Inspect before guessing fields. |
| Compose reports | `join`, `group-by`, `transpose`, `insert`, `select`/`reject` | Small fixture aggregation and JSON round trip tested. Keep records in Nu until the output boundary. |
| Reuse operations | Typed `def`/`export def`, modules, `help`, `scope commands` | Typed custom pipeline and signature discovery tested. Wrong literal argument types were rejected. Dynamic data still needs validation. |
| Handle external failures | `complete`, `try`/`catch` | Separate stdout/stderr and nonzero exit capture tested; catches retain `exit_code`. Capturing an error is not handling it. |
| Scope execution environment | `with-env`; deliberate `do --env` | Scoped values did not escape; `do --env` intentionally persisted them. Neither prevents a child process from reading its environment. |
| Parallel independent work | `par-each --threads N` | Bounded arithmetic fixture tested. Choose service-appropriate limits; do not parallelize competing writes. |
| Correlate background results | `job send --tag`, `job recv --tag --timeout` | Tagged receive selected the intended result and preserved a differently tagged message. Tags belong to messages, not `job spawn`. |
| Validate/timing | `use std/assert`, `timeit` | Assertions and duration output tested. Measure representative work, not just syntax overhead. |
| Inspect HTTP boundaries | `--full`, `--max-time`, `--redirect-mode` | Official documentation fetch returned `status`, `headers`, `body`, `urls`. Error envelopes and media types remain caller concerns. |
| Larger tables | Polars plugin | Installed binary worked in an isolated CLI round trip; it was not loaded/registered in the initial MCP session. |

A reusable typed transformation can stay functional and self-describing:

```nu
def "demo totals" []: table<team: string, value: int> -> table<team: string, total: int> {
  group-by team
  | transpose team rows
  | insert total {|row| $row.rows | get value | math sum }
  | reject rows
  | sort-by team
}
[[team value]; [a 2] [a 3] [b 4]] | demo totals
```

For a reusable module, export the command from a `.nu` file and load it with `use`. Parsing-time commands such as `use` and `plugin use` need their definitions available when the program is parsed; do not assume a preceding runtime expression can generate them within the same evaluation.

## Polars: available without changing the user's registry

On this machine, `which nu_plugin_polars` found `/opt/homebrew/bin/nu_plugin_polars`. The underscore matters; looking only for a differently named executable gave a false absence conclusion.

The following isolated probe passed. It loads the existing executable, not a newly installed plugin, and does not edit the normal registry:

```nu
^nu --no-config-file --plugins /opt/homebrew/bin/nu_plugin_polars --commands '
  [[team value]; [a 2] [a 3] [b 4]]
  | polars into-df
  | polars select team value
  | polars into-nu
  | to json
'
```

This proves basic compatibility, not a performance win. Benchmark a representative larger dataset before choosing a threshold. Inspect the plugin's current help for lazy scans, filtering/projection and supported file formats.

## Existing scripts: salvage useful interfaces, not stale assumptions

Public scripts under `~/.dots/webdesserts/agent-scripts/` were inspected, **not executed**.

| Script | Useful idea | Why it is not automatically ready for reuse |
|---|---|---|
| `feedpost.nu` | Exported command, preflight checks, structured return | Writes to a feed; has actor defaults, an override for unqualified keys and obsolete self-echo cleanup. Domain rules must match the current server. |
| `queue-watch.nu` | Compose a compact table from several service reads | Hardcodes six historical cards and uses raw UUID paths plus criteria-shadow checks. It is not the current queue. |
| `board-census.nu` | Summarize workspace state with external-command capture | JJ/workspace assumptions need validation on the target checkout. |
| `criteria-shadow-census.nu` | Inspect structured persisted data without opening a live database | Historical draft/snapshot assumptions; do not make unwanted machinery a permanent workflow dependency. |
| `jj-land.nu` | Explicit preconditions around a mutating operation | Changes a local bookmark. It is not an inspection command or generic approval to land work. |
| Feed/memory watchers and nightly consolidation scripts | Existing operational entry points | Long-lived or mutating, with older harness/identity assumptions. Do not launch duplicates or run them experimentally. |

A good next refactor is a small parameterized command library with documented effects and structured results—not another collection of hardcoded scripts. Updating these operational scripts is separate from this skill rewrite.

## Validation

Run the companion check in a **fresh process**, not by sourcing it into a working MCP session:

```nu
nu --no-config-file <skill-directory>/examples/self-check.nu
```

It checks typed composition, JSON round trips, command discovery, external errors, value-returning blocks, explicit heterogeneous mutation, scoped environment, URL segments, collection/scalar shape, bounded parallelism and tagged mailboxes. Fixtures contain no credentials, service writes or live vault access.

## Official references

- [Custom commands](https://www.nushell.sh/book/custom_commands.html) and [type signatures](https://www.nushell.sh/lang-guide/chapters/types/type_signatures.html)
- [Thinking in Nu](https://www.nushell.sh/book/thinking_in_nu.html)
- [External stdout/stderr/exit codes](https://www.nushell.sh/book/stdout_stderr_exit_codes.html) and [`complete`](https://www.nushell.sh/commands/docs/complete.html)
- [Environment](https://www.nushell.sh/book/environment.html)
- [Background jobs](https://www.nushell.sh/book/background_jobs.html), [`job send`](https://www.nushell.sh/commands/docs/job_send.html), [`job recv`](https://www.nushell.sh/commands/docs/job_recv.html)
- [Plugins](https://www.nushell.sh/book/plugins.html)
- [`http get`](https://www.nushell.sh/commands/docs/http_get.html) and [`timeit`](https://www.nushell.sh/commands/docs/timeit.html)
