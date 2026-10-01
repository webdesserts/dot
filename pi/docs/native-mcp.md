# Native MCP integration — Pi 0.99.2

Use Pi **0.99.2** and pi-subagents **0.74.0** before activating these changes.

Preserve and resume the existing conversation. `/reload` replaces extensions; it does not upgrade the running Pi core.

## Convert each machine's configuration

Remove pi-mcp-adapter from the configured packages and child-only extension paths. Keep its installed files until any old parent using it has closed.

Convert the existing private MCP configuration without changing its approved servers, commands, URLs or credentials:

| Adapter setting | Native replacement |
| --- | --- |
| `directTools` | Set each selected tool's `toolExposure` to `direct` |
| `includeTools` | Use `exposure: "hidden"`, then expose only the selected tools |
| `requestTimeoutMs` | Use `timeout` in seconds |
| Lifecycle and tool-prefix settings | Remove them; they are not native configuration fields |

Review authentication separately. Do not silently reinterpret an old authentication mode.

Pi 0.99.2 normalizes hyphens in raw MCP tool names to underscores. Discover the registered names rather than guessing them. The Nu selector `mcp:nushell/evaluate` remains valid with pi-subagents 0.74.0.

Preserve the machine's provider, model scope, role tools and skills, credentials, and notification identity. The public settings change deliberately excludes unrelated local model and role edits. Update independently configured packages, such as pi-web-access, separately.

See the [native MCP reference](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/mcp.md) for the complete configuration format.

## Keep parent profiles isolated

`mcp-profiles.ts` preserves Umbra's existing Iris and Peri `--mcp-config` launchers through native server registration.

It:

- Requires an explicit identity and the matching existing private profile.
- Registers only that parent's approved banks.
- Exits for native children.
- Takes shared servers from the machine's native global configuration.

**This is not a generic importer for another actor's profile.**

For Rhea, adapt the guard and allowed bank list to her existing approved profile, or use another native parent-only registration. Do not copy Umbra's credentials, bank bindings, profiles or launcher identity to another machine.

Do not add parent banks to shared child configuration for convenience. Do not widen a child's tool grants merely to give it codemode.

## Preserve context and notifications

`harness-context.ts` uses a named section for stable guidance, not a whole-prompt override. The documented `before_agent_start` hook applies to user-submitted prompts; it is not a promise of persistent sections across every custom-message wake.

Working Memory is delivered as a native custom context message at the first checkpoint and after successful compaction. It remains chronological history rather than replacing the system prefix with the latest edited file. Ordinary restart does not duplicate a delivered checkpoint; an interrupted checkpoint is recovered on startup. Manual compaction adds the snapshot without starting a model run solely to consume it. An active loop or planned retry receives it through native steering.

A short recent reminder asks the parent to load Nu and codemode through the native advertised skill paths or `/skill:name`. Existing discovery settings remain sufficient. This is on-demand skill loading, not deterministic full-body preloading or custom system-section copying. Codemode remains the preferred orchestration layer and Nu the shell/data layer.

Explicit identity, unavailable-note warnings and child exclusion are preserved. No pooled or other-agent note is used as a fallback. Native children retain their existing selected skills and tool grants.

The notification worker and protocol were not changed by this migration. Preserve the trusted origin and the machine's own credential, actor and SSE environment.

Diagnose transport problems separately. A runtime update or an absent optional setting does not establish their cause. Do not enable private prompt or credential tracing as a migration smoke test.

## Narrow shell tools for an owned task worktree

Pi-subagents supports project-scoped overrides of existing roles. Where a task requires Nu-only shell work, its owned worktree can exclude the direct Bash tool without changing global role defaults or creating another agent profile:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": { "excludeTools": ["bash"] },
      "forecast-reviewer": { "excludeTools": ["bash"] }
    }
  }
}
```

Place this in the worktree's `.pi/settings.json`, merging with existing settings and exclusions rather than replacing them. Coordinate at a quiescent writer boundary. Launch/discover from the intended task cwd and verify the resolved contract; project settings apply to that project until changed, not to one call automatically. Retained children keep their stored contract.

The installed 0.74.0 public call schema has no direct per-call tools/excludeTools parameter. Do not invent one or use a delayed tool-count budget as an immediate tool deny. Native discovery and builtin launch-plan checks confirmed the project exclusion preserves the model, skills and Nu selections while removing Bash. No real child was launched for that check.

This removes the direct Bash tool only. Nu remains capable of commands and filesystem writes, including invoking another executable; it is not a read-only sandbox or proof of complete shell-language enforcement.

## Check the integration

After resuming the same conversation, verify:

1. Native `/mcp` and an actual Nu call.
2. The owning parent's bank access.
3. Expected model, role, tool and skill contracts.
4. Notification delivery.

Parent metadata and source checks are not proof of real-child enforcement. Observe the next already-approved child under its existing contract rather than adding an unrelated benchmark or serving probe.

Codemode and Nu usage is documented in the [Nushell reference](../../agents/skills/nushell/references/codemode.md).

These notes do not authorize an Autonomy implementation, new profiles, task release or model-service changes.
