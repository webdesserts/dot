# Agent roster and deployment

The retained team is **Researcher, Scout, Worker and Claim Reviewer**. [The orchestrator prompt](../../agents/orchestrator.md) owns the collaboration model, planning, forecasting, reflection and time management. [Worker](../agents/worker.md) is the continuing implementation partner; [Claim Reviewer](../agents/claim-reviewer.md) supplies independent judgments when useful. [Scout](../agents/scout.md) and [Researcher](../agents/researcher.md) are conversational information buffers.

## Role-to-skill consolidation

| Retired role | Owning guidance |
| --- | --- |
| Planner / Forecast Reviewer | Orchestrator and [planning](../../agents/skills/planning/SKILL.md) |
| Analyst | Orchestrator's requirements conversation and [BDD](../../agents/skills/bdd/SKILL.md) |
| Architect | [Architecture review](../../agents/skills/architecture-review/SKILL.md) |
| Designer | [Visual review](../../agents/skills/visual-review/SKILL.md) |
| Hunt | [Defect review](../../agents/skills/defect-review/SKILL.md) |
| Coherence Reviewer | Whole-task composition checks in Claim Reviewer when assigned |
| Notetaker | Orchestrator and existing shared notetaking guidance |

These are optional perspectives, not a replacement staged pipeline. Deleted seats remain explicitly disabled in settings to prevent same-name package defaults from becoming active. No installed package file is patched.

## Configuration

`pi/settings.json` is the deployment authority for model/tool/thinking selection. The four prompt frontmatter defaults mirror it for portability; reconcile both when intentionally changing a role. All use `openai`: Sol6.1 medium for Worker/Claim Reviewer, Luna6 medium for Researcher and Luna6 low for Scout. This roster change does not alter provider credentials, model context overrides or approved tool grants.

Children use replace-mode role prompts and inherit repository instructions, not the operator's global/private context. They can see the discovered skill catalog; role-local skill paths and explicit selections make the shared skills available without copying their full bodies. Worker/Claim Reviewer select Nu, testing and docs; Researcher selects Nu/docs; Scout selects Nu. Skills are read on demand, not automatically executed stages. None of the roles receives permission to launch sub-agents.

The parent still supplies criteria, selected decisions and useful project-specific references. Supervisor dialogue uses the native bridge when provided; direct peer messaging is not assumed. No new persistent child-memory mechanism is configured.

## Apply at a review boundary

Review the source/settings diff before installing or reloading it. The directory mappings already exist in Dot.toml; Scout/Researcher user definitions shadow bundled resources. Compose roster changes with any pending settings/extension changes rather than replacing an entire configuration file or overwriting unrelated work.

After installation/reload, inspect the effective catalog and selected skill paths before the next authorized assignment. File/schema checks are not model-behavior or cold-MCP startup evidence. Retained child conversations keep stored contracts: a reload is not an automatic upgrade, and it is not permission to discard a task-long worker. Native resume checks eligibility; if it cannot continue, report the limitation and choose an explicitly labeled recovery with the orchestrator.

Bundled prompt recipes may still name seats outside this roster. Do not use them blindly or patch a package in place; choose a workflow that matches the retained roles and current authorization.
