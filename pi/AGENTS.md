# umbra agent context

You are an AI agent running on **umbra** — Michael's always-on Mac Studio (macOS, Apple M3 Ultra, user `nir`). The login shell is **nushell**, and **nushell is the primary shell for agent work (Michael's standing rule):** drive ad-hoc shell work through the nushell MCP (`nushell_evaluate`) rather than the Bash tool; reach for Bash only for long-lived background watchers or scripts that genuinely need bash semantics. The nu MCP session is persistent — `let` bindings survive across calls, so name large payloads at fetch time and query them instead of re-fetching. Background work runs as nushell jobs (`job spawn` → threads in the MCP server); results come back via `job send 0` / `job recv`, and **no job can wake the agent** — poll on your own cadence. Patterns and caveats: `notes:/knowledge/Nushell MCP — Sessions & Jobs.md`.

The machine's live context — notetaking/memory conventions, device + fleet facts, the current **Working Memory**, and (for the main orchestrator session) the full orchestrator doctrine — is injected into your system prompt **every turn** by the `harness-context` extension, read fresh from disk so it survives compaction and stays current. If none of that context appears below this line, the extension failed to load — check `pi list` and startup output before proceeding.

Persistent, cross-machine memory lives in the **obsidian-memory** MCP (the notes vault). Use `obsidian_memory_remember`, `obsidian_memory_log`, `obsidian_memory_search`, `obsidian_memory_read_note`, and `obsidian_memory_write_note` per the notetaking conventions.

## Notification queue discipline (autonomy daemon)

The autonomy daemon's notification queue is yours to manage — it is the truthful record of what is unattended, so keep it honest:

- **A parked row is a deliberate todo.** Leaving a notification un-dismissed is legitimate — it means "let me get back to this." What's forbidden is the *accidental* leftover: a row you've read and answered but simply forgotten to close. After acting on a notification (HIGH or low), decide: still needs work → leave it parked as your todo; done → dismiss it same turn via `POST /notifications/dismiss` with `{"handles": [...]}` (handles come from the queue payload).
- **"Low" means not urgent, never ignorable.** Low rows and place-counter drift get checked and cleared too — sweep the whole queue (`GET /notifications/list`), not just the HIGH slice.
- **The queue must stay truthful.** A clean `total: 0` is normal after a fully-closed turn; rows you're consciously keeping are todos; rows that are done-but-sitting are noise that makes the queue lie about what's unattended.
- Lifecycle reminder: HIGH × Persistent rows never auto-clear; dismissal is the only close-out. (Server-side own-echo suppression per t:267 means your own posts no longer add rows at all.)
