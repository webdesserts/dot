---
name: code-review
description: "Run a human-in-the-loop code review: prepare one coherent commit, collect line-specific feedback, amend the open review or defer larger changes, and verify the revision. Use when preparing code for Michael's review, responding to review comments, or operating a local Skepsis review."
---

# Code review

Make the change understandable to its reviewer. The review workflow supports judgment; it is not a substitute for reading source, checking behavior or discussing design.

## Agree on the review unit

For Michael's per-commit workflow, prepare **one coherent commit at a time**. Include the tests needed to understand and verify that change. Identify preparatory work honestly; do not call a contract draft a working algorithm.

The open review is one proposed commit with revisions, not a new commit for every comment:

1. Present the whole change against its parent/base.
2. Address feedback that belongs in the commit by amending it.
3. Discuss suggestions that would materially expand the change and record agreed work for a future commit.
4. Stop for human review after each response round. Do not build an unreviewed stack.
5. Begin the next commit only after approval of the current one.

Preserve useful prior revision references and record the old-to-new mapping when amending. Do not silently rewrite approved, merged or published history. Agreement to amend an open review does not authorize force-pushing or publication.

Adjust commit size or review frequency with Michael as experience suggests. Neither tiny commits nor large batches are inherently better. Keep unrelated refactoring, algorithm changes and integration work separate unless they form one genuinely inseparable change.

## Agent review before human review

Michael's review comes after an agent review, not instead of one. The worker produces a checked candidate and stops. The parent reviews the actual fixed diff/source and evidence, or commissions a claim reviewer when useful. Worker self-assessment and passing tests do not satisfy this gate on their own.

Resolve substantive findings and verify the resulting revision before presenting it to Michael. Preserve deliberate design questions for his judgment, but do not send known implementation defects as though the change is ready. Use proportionate checks and reuse valid evidence; this does not require a separate child or a full test campaign for every documentation edit.

While this gate is pending, keep the human's displayed review revision unchanged. The worker must not advance the published review ref, retarget Skepsis, open a new review revision or announce readiness for Michael without the parent's review disposition. Automatic child completion notices are candidate handoffs, not human-review readiness. After the gate passes, present the reviewed revision and stop for Michael's feedback.

## Prepare a reviewable change

Before presenting it:

- Inspect the actual diff and current working-tree state. Preserve unrelated edits and keep one writer per working copy.
- Check the real consumer and relevant source contracts, not just helper tests or an agent's completion report. A passing test can encode the wrong behavior.
- Run proportionate checks and record their actual outcomes. Use the project's testing guidance; prefer API-level integration tests for observable behavior, with focused unit tests where complex internals benefit.
- Write explanations for a colleague who knows the language but not this implementation. Explain the algorithm in prose; use code examples to explain the actual API and its use.
- Identify unresolved defects and limitations. Do not present them as optional design choices when source or behavior establishes a bug.

Give Michael a short handoff: purpose, commit SHA and base, important choices, checks, known issues and questions requiring his judgment. Describe what the current code does, not only its intended future behavior.

## Receive and disposition feedback

Read the current comments and bind them to their actual file/blob/revision. Preserve original wording and attribution. A comment on an older revision remains evidence; do not relabel it as a comment on the new one.

Take a bounded snapshot for each response round so new arrivals are not accidentally marked handled. Combine Michael's feedback and agent findings in the work brief, but distinguish their authorship. Check that feedback still applies before editing.

Each item should end as:

- **Addressed:** point to the correction and evidence.
- **Deferred by agreement:** explain why it belongs in a future commit and retain a pickup item.
- **Needs discussion:** explain the ambiguity or disagreement rather than silently ignoring it.

Share substantive agent findings too. Do not make Michael discover known defects unaided. Passing checks or completing a comment batch is not his approval of the commit.

When feedback changes scope, tell the worker clearly. A queued message is not proof it was incorporated; inspect the returned revision. If the writer has already stopped, do not claim a late steer changed the result.

## Present the revised commit

Keep the review showing **the whole proposed commit against the same parent/base**, not merely the latest correction diff. For a root commit, use the repository's actual empty-tree object. Announce the new SHA and briefly summarize addressed and deferred items.

Verify the working tree and intended changes before reopening review. Keep feedback and test evidence through amendments. Never delete unresolved source review markers or tool comments just to make the diff look clean.

Stop writing while Michael reviews unless he has explicitly agreed to a different interaction. If waiting for human input, pause autonomous work rather than manufacture another change. A feedback file or background server does not by itself notify an agent; establish how comments will be consumed.

## Local review tools

For Skepsis, read [the local review guide](references/skepsis.md). Keep one reusable server/tab per review context: repository/worktree, branch and effort. Different contexts can have separate tabs and feedback streams; do not replace an unrelated review. Before starting the server or opening the first tab for a context, create and verify dedicated **base and current refs**, such as `refs/review/<context>/base` and `refs/review/<context>/current`. Configure both diff endpoints with those refs, not literal commit IDs or the worker's moving `HEAD`. Keep the base fixed during amendments; after human approval, publish the next review unit's base/current pair coherently. Advance the displayed revision only with the parent's review disposition and use the existing tab's refresh controls. Give Michael the full authenticated review link directly in this private chat rather than a shell command to retrieve or copy it; keep its token out of shared artifacts. Tool setup, installation, serving, commits and publication remain separate authority boundaries; this skill grants none of them by itself.

Use [testing](../testing/SKILL.md) and [docs](../docs/SKILL.md) for their owning concerns. Apply architecture, defect or visual review perspectives when the change warrants them, not as mandatory extra stages.
