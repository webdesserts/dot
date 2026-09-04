# apply-patches.nu — idempotent post-install patches for pi's npm extensions.
# Run after any `pi` extension/package install or update. Rhea runs this too
# (dots-pulled) so every agent seat carries the same fixes.
#
# Usage: nu apply-patches.nu

# ── pi-subagents: nudge + watchdog sends must use pi's real option name ──
# pi.sendUserMessage takes { streamingBehavior: "steer" }. The package calls
# it with { deliverAs: "steer" } — an unknown option pi ignores, so the call
# reads as bare, gets refused while the agent is busy ("Agent is already
# processing"), and the nudge/warning is silently dropped.

const PATCH = path self parent-path "pi-subagents-nudge-steer.patch"
const TARGET = $"($env.HOME)/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts"

def main [] {
	if not ($TARGET | path exists) {
		print $"(ansi yellow)pi-subagents not installed — skipping\(ansi reset)"
		return
	}
	let src = open --raw $TARGET
	# already patched?
	if ($src | str contains "streamingBehavior: \"steer\"") {
		print "pi-subagents nudge patch: already applied ✓"
		return
	}
	let upstream = $src | str replace -a '{ deliverAs: "steer" }' '{ streamingBehavior: "steer" }'
	if $upstream == $src {
		print $"(ansi yellow)upstream changed — patch no longer matches, skipping\(ansi reset)"
		return
	}
	$upstream | save --force $TARGET
	print "pi-subagents nudge patch: applied ✓"
}
