---
name: codemode
description: "Default Pi tool orchestration: compose calls, bound output, inspect errors and manage state without widening permissions. Use alongside Nushell for shell and data work."
---

# Codemode for Pi orchestration

Pi parent orchestrators normally load this skill and the Nushell skill together. Prefer codemode as the orchestration layer; keep shell execution and substantial data pipelines in Nu.

Use Pi's native advertised skill paths or `/skill:name` to load the instructions. A recent post-compaction reminder asks for these reads; it does not manually embed skill bodies into the system prompt or guarantee model compliance.

A direct atomic tool call is still appropriate when a wrapper adds no useful coordination. Fewer top-level calls alone is not an efficiency metric.

## Working pattern

1. Decide what evidence or fields the next decision needs.
2. Discover actual tools and result shapes; do not guess names or envelopes.
3. Compose independent reads with `Promise.allSettled`. Serialize dependent or stateful operations.
4. Check each result before using it or starting a dependent effect.
5. Return a bounded conclusion, or readable text when the consumer needs prose.

Filter near the data first. A complete MCP result is not necessarily the server's original untruncated data. If Nu retained a large value, query that value rather than rerunning the operation or dumping it into context.

Do not wrap every single Nu call mechanically. The useful outcome is fewer unnecessary model round trips, less repeated work and clearer evidence—not more JavaScript.

## Errors and partial effects

JavaScript failure, MCP `isError`, external `exit_code`, HTTP status and application success are separate layers. Promise fulfillment or “Script completed” does not establish task success.

Completed calls are not undone when a later step fails. Inspect receipts and partial state before retrying an uncertain effect. Await every started call; do not leave unobserved work behind.

## State and authority

Script locals, codemode `store`/`load`, Nu bindings and durable artifacts have different lifetimes. Validate or reconstruct state after restart, branching or session changes. Do not put secrets or bulk private data in transcript store entries.

Nested calls retain the host's permission and identity boundaries. This skill does not authorize new tools, profiles, child launches, services or another actor's banks. Preserve the assigned role contract.

Nu jobs do not wake the agent. Use the approved host completion mechanism and durable receipts for background work; `await` is not a completion subscription.

## Keep learning from ordinary work

Record representative successes and friction, separating observation from documentation and hypotheses. Note excess output, repeated work, repair turns, missing state and confusing error layers. Do not expand every annoyance into a new framework or benchmark campaign.

Write readable notes with normal spacing, short paragraphs and clear headings. Summarize structured data; do not wrap long Markdown in a JSON field when the reader needs prose.

See the [tested Nu integration patterns](../nushell/references/codemode.md) and [[Pi Codemode + Nushell — trials and Autonomy implications]]. Keep detailed evidence there rather than duplicating it in prompts.
