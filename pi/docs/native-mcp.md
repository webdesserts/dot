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

`harness-context.ts` now writes a named `harness_context` section instead of forcing the whole system prompt. This lets native MCP discovery add its own section afterward.

The following behavior is unchanged:

- Explicit memory identity.
- Per-turn memory rereads.
- Honest unavailable-note warnings.
- Child exclusion.

The notification worker and protocol were not changed by this migration. Preserve the trusted origin and the machine's own credential, actor and SSE environment.

Diagnose transport problems separately. A runtime update or an absent optional setting does not establish their cause. Do not enable private prompt or credential tracing as a migration smoke test.

## Check the integration

After resuming the same conversation, verify:

1. Native `/mcp` and an actual Nu call.
2. The owning parent's bank access.
3. Expected model, role, tool and skill contracts.
4. Notification delivery.

Parent metadata and source checks are not proof of real-child enforcement. Observe the next already-approved child under its existing contract rather than adding an unrelated benchmark or serving probe.

Codemode and Nu usage is documented in the [Nushell reference](../../agents/skills/nushell/references/codemode.md).

These notes do not authorize an Autonomy implementation, new profiles, task release or model-service changes.
