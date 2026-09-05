# Nushell as the model-facing tool kernel

Exploration, not an adopted architecture. Michael is considering one persistent Nushell interpreter as the primary tool interface, analogous to Prime Agent's Python environment. His reasons include shell familiarity, stronger typing and a functional composition style.

## The promising part

The useful abstraction is **code over retained values**, not merely fewer tool names. An agent can retrieve large results, keep them outside its context window, join/filter them, call other capabilities with those values and expose only the useful conclusion. Nu already supports this within one process through variables, structured pipelines, closures, custom commands and modules.

Typed command signatures and `scope commands` offer a discovery surface. Records/tables make CLI and service results easier to compose than unrelated text outputs. Pipelines fit filter/map/group/join workflows naturally. Shell interoperation remains close at hand without making string construction the default way to pass data.

The practical target would be **Nu-facing commands backed by an authoritative host**, not moving every subsystem into Nu. The host can expose capabilities while Nu composes them.

## What Prime actually separates

Inspected documentation and the Python `rlm.run` shim at commit `5c2750bdc3c99cc4225c1167a3484371a7a221ab`:

- The built-in model interface is `ipython`; variables and imports persist across calls and compaction.
- Python sends typed host requests; the TypeScript host owns providers, credentials, child lifecycles, budgets, routing, scheduling and transcript persistence.
- The kernel is not a security sandbox.
- Current `await rlm(...)` returns an **admission handle**, not a completed answer. Child answers arrive through explicit agent messages or files. The parent can then process artifact data in the interpreter.

That last distinction matters for a Nu design: spawning, checking status, receiving completion and reading a result need explicit contracts. An `await`-looking call or successful outer tool response must not be mistaken for finished work.

Sources: [programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/5c2750bdc3c99cc4225c1167a3484371a7a221ab/packages/coding-agent/docs/rlm.md), [runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/5c2750bdc3c99cc4225c1167a3484371a7a221ab/packages/coding-agent/docs/rlm-runtime.md), [Python shim](https://github.com/PrimeIntellect-ai/prime-agent/blob/5c2750bdc3c99cc4225c1167a3484371a7a221ab/prime-agent-runtime/src/rlm/__init__.py). This was source/documentation research, not a runtime test of Prime Agent.

## Seams the language does not solve alone

| Seam | Nu contribution | Host/adapter requirement |
|---|---|---|
| Discovery and types | Signatures, help, typed values, plugins | Stable capability catalog and semantic validation. Nu types are not automatically full JSON Schema or effect/permission metadata. |
| Context exposure | Filter retained values before returning them | Explicit bounded output, artifact references and media/display handling. Current MCP `print` behavior differs from ordinary CLI stdout. |
| Failures | Native errors, catchable external failures, `complete` records | Preserve failure status across boundaries; distinguish transport, process and application errors rather than returning every failure as success data. |
| Concurrency | Independent pipelines, bounded parallel iteration, jobs/mailboxes | Define serialized kernel evaluations versus concurrent host work. Do not share mutable interpreter state between unrelated agents accidentally. |
| Completion | Mailboxes retain results within a live process | Durable job IDs/results and an event that can actually wake the parent. `job recv` is not itself a harness notification. |
| Cancellation | Nu interruption and job controls | Defined descendant cancellation, timeout ownership and recovery receipts. An outer transport timeout need not terminate work. |
| Persistence | In-process variables and modules | Checkpoints/reconstruction across process death. Compaction survival is not restart durability. |
| Permissions and secrets | Structured arguments reduce string-assembly mistakes | Host/server authorization, audit/provenance and protected credential resolution. Arbitrary interpreter/OS access is not a sandbox. |

An important local example: an evaluation exceeded the outer MCP deadline despite a larger Nu promotion threshold. The session reset while external work finished, losing the enclosing receipt. Do not infer the exact failure mechanism from documentation about promotion; a reliable primary interface must test and define it.

## Focused experiments before a switch

1. **Typed command facade:** wrap a few fixture-only host operations as Nu commands. Compare discoverability, argument errors and composition against today's separate tools. Keep domain validation in the host.
2. **Output shaping:** retrieve a large synthetic result set, retain it, produce a small summary and retain an artifact pointer. Measure context bytes/tokens and execution cost, not just command count.
3. **Child lifecycle:** expose distinct admission, status and result operations. Prove a completed-result value cannot be confused with a launch receipt, and test a real parent wake without polling conversations.
4. **Failure and recovery:** test nonzero exits, application errors, cancellation, outer timeout, interpreter restart and orphan cleanup in a disposable process. Assert what survives and which operations must not be blindly retried.
5. **Trust/effects:** verify that interpreter composition does not bypass approval, identity or filesystem boundaries. Decide whether the intended environment is trusted-user execution or a real sandbox; do not imply the former provides the latter.

A fair comparison should include Python and today's MCP/script interface on the same workloads, including model command-error rate, repair turns, context size, latency, cancellation and recoverability. Nushell's ergonomics are a promising fit; these measurements would establish whether it is the better kernel for this harness.
