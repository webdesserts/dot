---
name: docs
description: "Documentation, code comments, and JSDoc standards. Use when writing or reviewing documentation, inline comments, JSDoc, or any prose in code. Also use when cleaning up, improving, or evaluating comment quality."
---

# Documentation and comments

Write for a colleague who knows the language and product but is new to this part of the code. Use concise, readable sentences. Explain necessary terms; avoid jargon, repeated rules and examples that no longer help.

## Prefer clear code

Use good names and simple structure before adding comments. Explain intent, constraints, surprising behavior and non-obvious tradeoffs—not what an obvious statement does.

Document public contracts where users encounter them: purpose, inputs, results, errors and important limits. Add examples when they clarify use. Self-explanatory internal helpers need little or no commentary; complicated algorithms and business rules need enough explanation to maintain them safely.

Keep the documented API aligned with intentional exports. Do not expand the public interface just to document internal helpers.

## Keep guidance current

When behavior changes, check the affected documentation and comments. Describe the current contract rather than the debugging history. Preserve useful reasoning when moving code; remove or replace stale explanations instead of adding a contradictory paragraph.

Mark temporary workarounds, explain why they exist and when to remove them. Address temporary `~rev:` review comments, then remove them; do not erase unresolved feedback.

Place JSDoc on the relevant declaration so editors can show it. Use headings, short paragraphs and lists for longer material. Avoid personal asides, repeated warnings and large examples when a sentence or link would do.

Before adding guidance, look for its existing home. Consolidate there rather than creating another competing checklist. Documentation should make the important instruction easier to find, not merely increase its repetition.
