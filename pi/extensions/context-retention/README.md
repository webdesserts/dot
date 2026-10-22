# Native compaction retention

This dots-managed extension removes **provenance-backed, mechanically appended file inventories** from future summarization input and restored normal provider context. It does not replace Pi's summarizer or change context-controls' settlement/restoration lifecycle.

## Policy

Only native `compaction` and `branch_summary` entries qualify. Their details must contain sorted, unique, disjoint string `readFiles`/`modifiedFiles` arrays; nonempty inventories must exactly match Pi's terminal generated suffix. `fromHook:true` summaries, missing/malformed details, embedded/ambiguous blocks and ordinary user/assistant/code text are preserved. Useful inline paths and checkpoint narrative remain intact. This is a conservative archive-format convention, not cryptographic provenance.

The same pure policy is used on three surfaces:

- `context` returns cleaned typed `compactionSummary`/`branchSummary` views, matched to source entries on the active branch. It does not modify stored entries or actual tool/result messages.
- `session_before_compact` cleans the existing preparation's previous summary and both history/split-prefix message arrays. It replaces its fresh file-operation sets with empty sets, so the new native compaction does not append another inventory or persist cumulative arrays. Native cut boundaries, tokensBefore, settings, provider routing/auth/env/headers, stream/retry callbacks and usage accounting remain native.
- `session_before_tree` replaces elements of the existing entries array with cleaned clones, including removal of inherited native inventory arrays from cloned details. The selected raw messages/tool calls are not erased or renamed.

The last two seams are **source-qualified in-place mutation**, not a documented preparation-result override. Handlers return no custom summary. Pi's documented cancellation result is used when compatibility cannot be established.

## Qualified SDKs and upgrade behavior

The acceptance/deployment target is **Pi 1.4.0 only**, recorded in `hooks.ts`. Real native AgentSession/faux-provider consumers exercise manual/automatic/repeated/split/tree paths. Earlier 1.3.0 receipts are historical evidence, not a supported deployment target; the owner is upgrading sessions to 1.4.0. No broad version range is inferred.

On an unqualified SDK, or an unsupported/frozen preparation shape, summary-producing compact/tree operations are cancelled with a bounded actionable diagnostic. Ordinary navigation without summarization is not blocked. Unknown-version ordinary projection makes no cleanup assumptions. An SDK upgrade therefore requires running/inspecting the consumers and updating the exact version set before activation, not merely retrying a cancelled operation.

The compatibility dependence is that native compact retains the preparation **object** across the event, while native tree retains the entries **array**. Reassigning an event's preparation/array property is not equivalent. Structural checks complete before mutation; throws are not used to pretend to fail closed, because Pi's runner catches extension errors.

## Limits

- New raw branch summaries can still contain inventories extracted from their selected raw history, which can include old tool calls. Provider and future-summary views are cleaned; archive storage is not bounded and raw branch entries are not promised inventory-free.
- Virtual-router decision context remains native/canonical. This does not sanitize router-internal history or issue replacement router/model requests.
- Canonical pre-compaction estimates/cut selection can still count a legacy inventory before it is replaced by a clean checkpoint. Provider usage remains actual usage; tokensBefore and the recent boundary are not rewritten to disguise the distinction.
- Ambiguous/model-echoed inventory-like prose may remain. There is no hard narrative cap and no claim that semantic checkpoints remain bounded forever.
- Raw JSONL, session identity, branch archives and notification receipts are untouched. This does not fix the separate whole-UTF8 receipt-reader problem.

## Deployment and verification

`Dot.toml` links this directory; `pi/settings.json` explicitly selects it for parents and lists it in native children's extension selection. Editing these definitions in a worktree does **not** activate them. Integration/link installation/reload is a separate owner-controlled step, especially for live sessions with production jobs.

Tests live in `pi/tests/context-retention/`. The context-controls lifecycle and cross-extension fixtures also load an owned copy of retention, preserving their original behavioral assertions. `pi/tests/context-controls/sdk.mjs` resolves public peer exports from the selected SDK's real dependency graph rather than assuming nested node_modules. It deliberately reports missing/unsupported capabilities instead of installing dependencies or skipping tests. Node 26.12.1 was used for this qualification; the helper requires Node's public `module.findPackageJSON` API.

From the repository root in Nushell:

```nu
with-env {PI_SDK_ROOT: '/path/to/installed/node_modules/@earendil-works/pi-coding-agent'} {
  node --test --test-reporter=tap ...(glob pi/tests/context-retention/*.test.mjs) ...(glob pi/tests/context-controls/*.test.mjs)
}
```

Fixtures use fresh owned agentDir/cwd, in-memory session/settings, network-disabled ModelRuntime and native in-process faux streams. The retention fixture's ProviderAuth resolver returns only explicit synthetic API-key/header/env data, without reading real credentials or environment. Do not layer `registerProvider` onto the same native faux provider: that public compatibility registration intentionally removes its native registration and cannot route the faux provider's unique API. Tests assert native dispatch, synthetic auth/header/env, routing ID, signal, retry callbacks and nonzero returned usage.
