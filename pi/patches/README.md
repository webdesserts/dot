# Temporary package patches

## Pi v1 / pi-subagents 0.74.0 background launcher

**Temporary workaround; remove when upstream fixes it.** Pi 1.0.0 removed the unused `@earendil-works/pi-agent-core/node` export. Pi-subagents 0.74.0 still treats that alias as mandatory, refusing native background launches before creating a child.

`pi-subagents-0.74-v1-node-alias.patch` skips only this absent export on stable Pi 1.x. All other alias requirements remain. Legacy, prerelease and other-major hosts are unchanged; an advertised export whose file is missing still fails validation. This does not change child tools, models, credentials, role settings or execution mode.

The patch was authorized by Michael at `/feed:main.m:0tm8zra240`. It is applied to Umbra's installed `pi-subagents/src/runs/background/runner-aliases.js`. In the observed Peri session, `/reload` did not activate the changed dependency graph; a full process restart through the existing exact-conversation launcher did. An inert Jiti/alias fixture also retains the old resolver across fresh loader instances and sees the patch in a new process. Do not assume resource reload clears imported package modules. Coordinate a quiescent same-conversation process restart for this patch, then use the next normal approved child—not an extra inference probe—for launch evidence.

### Reapplication guard

Do not automatically apply this after updates. Use it only for the known 0.74.0 file with SHA256 `7d259ec64a8e8189fa54b96105c337656b42b9ed989ab6aeb09edf0835871f1c`, after confirming this same failure on Pi 1.x. A new package version or changed source requires inspection, not a forced patch. Do not change the unrelated nudge patch or run a blanket patch script for this fix.

### Upstream retirement

At the next pi-subagents update, inspect the unmodified upstream `resolveHostPeerAliases()` against the installed Pi host. If it resolves without demanding the removed export, **do not reapply this patch**; remove this patch file and this section after consuming the normal launch receipt. A package update normally replaces the local vendor edit. Never restore the old 0.74.0 source over a newer upstream file.

Track releases at <https://github.com/nicobailon/pi-subagents/releases>. No upstream issue or pull request has been submitted by this change.

### Evidence and reversal

Umbra's original source, checksums and inert red/green checks are retained in `~/.pi/agent/handoffs/iris-pi-0991-20260930/` as `v1-runner-alias-0.74.0.original.js` and `v1-runner-alias-applied-check.{mjs,json}`. All twelve resolved aliases are unchanged. The installed patched file has SHA256 `9c5be54b5e5453415e4e9d602bf1428d7bb519f14f90deaa824617a3f00c8a73`.

For an explicitly approved reversal, first verify the installed package is still 0.74.0 and the file matches that patched checksum. Restore only that original file at a quiescent boundary and restart the parent into the same conversation. A mismatch means preserve the current state and inspect it; do not overwrite another update.
