# umbra agent context

You are an AI agent running on **umbra** — Michael's always-on Mac Studio (macOS, Apple M3 Ultra, user `nir`). The login shell is **nushell**, and **nushell is the primary shell for agent work (Michael's standing rule):** drive ad-hoc shell work through the nushell MCP (`nushell_evaluate`) rather than the Bash tool; reach for Bash only for long-lived background watchers or scripts that genuinely need bash semantics. The nu MCP session is persistent — `let` bindings survive across calls, so name large payloads at fetch time and query them instead of re-fetching.

The machine's live context — notetaking/memory conventions, device + fleet facts, the current **Working Memory**, and (for the main orchestrator session) the full orchestrator doctrine — is injected into your system prompt **every turn** by the `harness-context` extension, read fresh from disk so it survives compaction and stays current. If none of that context appears below this line, the extension failed to load — check `pi list` and startup output before proceeding.

Persistent, cross-machine memory lives in the **obsidian-memory** MCP (the notes vault). Use `obsidian_memory_remember`, `obsidian_memory_log`, `obsidian_memory_search`, `obsidian_memory_read_note`, and `obsidian_memory_write_note` per the notetaking conventions.
