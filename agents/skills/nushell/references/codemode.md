# Pi codemode alongside Nushell

Checked on Umbra with Pi **0.99.1** and Nu **0.114.0**, 2026-09-30. This is optional host-specific guidance, not a requirement for every client or child agent. Use codemode only when the host offers it and the task authorizes the underlying operations.

## Division of work

- **Nu:** filesystem/process work, HTTP and structured pipelines, reusable typed commands, Polars, persistent interpreter values.
- **Codemode:** coordinate several tools, filter their results before returning them to the model, combine Nu output with other tool results, and retain small derived values through `store`/`load`.
- **Host:** credentials, capability enforcement, effect receipts, cancellation and durable completion delivery. Neither language independently supplies those guarantees.

For one shell operation or a report expressible as one Nu pipeline, call Nu directly. Add codemode when it removes otherwise necessary model round trips or joins results from different capabilities. Avoid moving a good Nu pipeline into JavaScript just to use the new feature.

## Consume structured Nu results

Pi's native MCP call resolves to a `CallToolResult`. In the tested Nu server, successful value-returning evaluations have `structuredContent.output`; errors have `isError: true` and a different structured error shape. Do not parse the printable NUON text when structured content is available.

This local-only example summarizes git status without returning the whole status output:

```js
const result = await tools.mcp__nushell__evaluate({
  input: `
    let status = (
      ^git -C /path/to/repo status --porcelain | complete
    )
    {
      exit_code: $status.exit_code
      changed_lines: ($status.stdout | lines | length)
    }
  `
});
if (result.isError) throw new Error("Nu evaluation failed");
const envelope = result.structuredContent;
if (!envelope || !("output" in envelope)) {
  throw new Error("Expected a value-returning Nu evaluation");
}
const output = envelope.output;
if (output.exit_code !== 0) throw new Error("git status failed");
text({changed_entries: output.changed_lines});
```

An evaluation that only declares a binding can return a `note` instead of `output`. The guard above is intentionally for an expression that returns a record. Inspect unfamiliar shapes before projecting fields.

Counted porcelain lines are a summary, not a filename parser for automation.

Return a bounded conclusion. Do not dump whole MCP results, environments, credentials or private histories for convenience. Keep necessary artifacts in an approved location.

Filter large data in Nu or Polars before transfer where possible. Otherwise, codemode can filter the full tool result before it enters model context.

## Check all failure layers

Observed in the live trial:

1. `error make` produced an MCP result with `isError: true`, but the codemode script completed normally when it merely printed that result.
2. `^false | complete` produced `exit_code: 1` inside a successful Nu/MCP evaluation (`isError: false`).
3. `print` followed by a final record did not put the printed line in the MCP result; the returned record was visible.

Therefore a completed script is not proof of successful work. Check JavaScript errors, MCP `isError`, external `exit_code`, and application-level status/criteria separately. Use explicit final values for diagnostics rather than relying on `print`. Redact error details before forwarding them.

## Keep state ownership explicit

| State | Tested behavior | Boundary |
|---|---|---|
| Script-local JavaScript | Fresh per codemode call | Use `store`/`load` for cross-call values, not local variables |
| Codemode `store`/`load` | A small summary survived successive successful calls; a change in a failed script did not replace its prior stored value | Pi documents session/branch persistence; restart/fork behavior was not tested here |
| Nu REPL | Named bindings survived successive calls, including a binding declared before a Nu error | Process-local, not a durable or branch-aware ledger |
| External effects | Codemode warned that completed calls were not undone after a script failure | Verify receipts before retrying any mutating operation |

A controlled test created a temporary Nu binding, changed a codemode store key, then threw a JavaScript error. The Nu binding remained; the store key retained its earlier value. **These are different state domains, not one transaction.** Nu errors also did not roll back earlier bindings.

Use task-specific names for retained Nu values. After a restart, timeout/reset, `/tree`, fork or session switch, validate or reconstruct interpreter state rather than assuming it matches the active conversation branch. Do not store secrets or bulk private payloads in codemode transcript entries.

## Concurrency, permissions and jobs

- Use `Promise.allSettled` for independent tool reads whose separate outcomes matter. Inspect each outcome and each MCP result's `isError`; a fulfilled promise can still contain a failed tool result.
- Serialize dependent Nu evaluations and anything sharing mutable bindings, cwd, environment, files or actor state. Parallel JavaScript calls are not evidence of separate Nu sessions.
- Await every started tool call. Leaving a script does not register a durable background job; pending calls can be cancelled while already-completed effects remain.
- Codemode does not grant permission to spawn children, start services or access another agent's banks. Nested calls still pass through the host's tool pipeline. Do not add codemode or extra MCP sources to a child's contract merely to follow this reference.
- Nu jobs still do **not** wake the agent. Do not park a codemode script indefinitely on `job recv` or assume that `await` creates a completion subscription. Use finite waits, durable receipts and the approved host completion mechanism.
- A transport timeout is uncertain completion, not permission to rerun effects. Inspect exact owned processes/jobs and receipts first.

## Discovery and version changes

Discover registered names with `searchTools()` or `ALL_TOOLS`; do not infer them from prose aliases.

Pi 0.99.2 changes raw MCP hyphen normalization and discovery behavior. The trials above ran on Pi 0.99.1. A separate 0.99.2 compatibility check passed, but the running parents still need coordinated activation.

`describeNamespace()` is a 0.99.2 addition. Do not assume it exists on 0.99.1.

## Evidence and sources

Warm-session trials inspected actual role settings (12 enabled roles, all local GLM and selected Nu), parallelized independent tool reads, filtered the returned table, reused Nu bindings and codemode store values, and checked controlled Nu/process/script failures. No child inference, production file/service effects, restart/fork test or net token/latency benchmark was performed.

Field notes and Autonomy design implications: [[Pi Codemode + Nushell — trials and Autonomy implications]]. Host/kernel background: [tool-kernel assessment](tool-kernel.md).

- [Pi 0.99.1 CLI tools and codemode](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/cli.md#tools)
- [Pi 0.99.1 MCP](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/mcp.md)
- [Pi 0.99.1 extension permissions and nested calls](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md)
- [Pi 0.99.2 release notes](https://github.com/earendil-works/pi/releases/tag/v0.99.2)
