# Skepsis review workflow

Upstream: https://github.com/oxidecomputer/skepsis. These behaviors were checked for the installed 0.5 release; verify the selected version before relying on flags, base-path behavior or authentication details.

## Set up deliberately

Use a pinned version in an owned tool location when installation is authorized. Do not silently install globally, update tools or expose a public listener. Start on loopback on the owning machine; remote-machine exposure is a separate setup and authorization decision.

## Reach the reviewer's machine

Establish whether Michael is reviewing on the same machine or another one before choosing a URL. A loopback address is meaningful only on that machine; never present it as a remotely reachable review link. Distinguish the local application URL from any separately authorized gateway, tunnel or reverse-proxy URL, and inspect the selected version's base-path, API and authentication behavior before relying on a proxy.

The inspected installed 0.5 behavior has no base-path option: browser assets and API routes are root-relative. The initial HTML may be reachable without authentication, while API requests require the per-run `X-Skepsis-Token`; Send also has a loopback Host/Origin security gate. A path-mounted reverse proxy can therefore fail or behave differently, and a proxy is not made correct by weakening headers, forging Host/Origin or disabling the gate. Verify the actual selected version and served behavior rather than generalizing these details to every release. If remote access is not established, report it as unknown or blocked; do not imply that a local server is remotely reachable or invent a gateway, authentication or DNS setup.

Choose explicit VCS and revision arguments. For Git, the intended view is the open commit's base/parent to its published review revision. **Before starting the server or opening the first tab**, create two context-specific refs, such as `refs/review/<context>/base` and `refs/review/<context>/current`. Point the base ref at the intended parent (the repository's actual empty-tree object for a root commit) and the current ref at the parent-authorized candidate. Verify both resolved object IDs and the full diff, then start Skepsis with those ref names as `--from` and `--to`.

Do not start with a literal base SHA and plan to add a base ref later: moving to the next commit would require server reconfiguration and could rotate the authentication token. Neither endpoint should follow the worker's moving `HEAD`. Record the exact base/candidate IDs, and ensure newly added files appear in the review; an ordinary working-tree diff can omit untracked files.

Skepsis supports Git and jj. Check their different revision semantics rather than assuming the same flags mean the same range. Keep the full commit view through amendments, not the previous-revision-to-new-revision delta.

## Choose how comments reach the worker

Skepsis's **Comment** action writes markers into source files. Do not enable that path against a working copy an agent is concurrently editing without an explicit coordination plan.

For a stable committed-only review, prefer **Send** to an owned local feedback file initially. It delivers JSON containing file, side, line range, code excerpt, blob identity, text and a prompt. Preserve those identities and the original records. A later amendment does not change which revision an old comment refers to.

The configured Send command runs through a shell. Keep it fixed and simple, consume comment content as data on stdin, and never evaluate that content as shell code. Do not wire feedback directly into agent execution or terminal control without agreement. There is no assumed native Pi integration.

A successful send means the configured receiver accepted the comment—not that an agent read it or a human approved the code. A feedback file alone provides no agent wakeup. Read current feedback when asked to address comments, or use an explicitly established notification mechanism.

## Open an authenticated view

The startup URL includes a fresh secret fragment supplied for that server run. A bare host/port can show **No valid access token**, even though HTTP `/` returns 200.

Capture the full URL privately, then give Michael a **direct, clickable authenticated link in this private chat**. Do not make him run a shell command or `pbcopy` merely to retrieve the link. Treat the fragment as a per-run access secret: do not copy it into commits, shared reports, feeds or public logs, and do not print the token separately. Delivering the link does not authorize opening an extra browser tab; use an authorized browser-opening mechanism only when appropriate.

A server-local URL is not proof that a remote reviewer can access it. If Michael is on another machine, use only the separately established remote URL and verify the view from his actual location, including any required base path and authentication. Do not claim access merely because the server started, the local HTML responds, or an earlier browser tab worked on another machine.

When a tab already exists for this context, tell Michael to use the link in that tab. After successful initialization, the token-free address can work in that same browser for that server run. A different browser, machine or restarted server may require the full authenticated link again.

Do not claim the browser opened or the view is usable merely because the server started. Report separately:

- server/listener identity and local or published URL;
- whether the reviewer's location was verified as able to reach it;
- browser-open command outcome;
- actual visual confirmation, if obtained.

If the user reports an access-token error, hand them the current full authenticated startup link directly rather than repeatedly giving them the bare address or a command to retrieve the link.

## One tab per review context

Identify the repository/worktree, branch and effort for each review. Keep a reusable tab/server for that context, not one global tab for all work. Separate contexts can run concurrently on separate loopback ports, with their own feedback files, review refs and process receipts. Do not overwrite an unrelated review to show another change.

A single review context can span computers: the server may run on one machine while Michael reviews from another. Preserve stable base/current refs, repository identity and the exact served diff across that boundary. Machine-specific routing, authentication, process custody and token handling belong in the owning machine/context pickup, not in this reusable skill. Verify the accessible view from Michael's location rather than treating the server host's local view as evidence.

A new commit or amendment within an existing effort normally reuses that context's tab. Give concurrently active contexts distinct review-ref names; a single shared `refs/review/current` must not let one effort replace another's view.

## Keep that context's server and tab through amendments

Skepsis reruns the Git diff when polling; explicit `--from` and `--to` revisions are passed to Git rather than permanently resolved at startup. Dedicated base/current refs therefore let one server follow approved amendments and later review units without restarting or opening new tabs. This behavior is supported by the inspected 0.5.0 source; validate the installed version and actual served diff when setting up the workflow.

For one open review:

1. Create and verify both context-specific refs before the first server start/tab open: base at the intended parent, current at the revision authorized for presentation. Start Skepsis once with `--from refs/review/<context>/base --to refs/review/<context>/current`. This remains a committed-only diff; it does not include working-tree edits.
2. Let the worker prepare candidate amendments without advancing the published review ref. Do not use `HEAD` or a branch the worker changes: that would bypass the agent-review gate.
3. After the parent or claim reviewer has checked the candidate and the parent authorizes presentation, preserve the previous revision and advance the review ref with an expected-old-value check. Record the exact old/new SHAs and verify the served diff matches the intended full change.
4. Keep the server, port, token and browser tab alive. Use Skepsis's diff-change polling and Refresh controls to show the revised diff in that tab. Do not invoke the browser-opening command for each amendment.
5. Keep the base ref unchanged throughout amendments to the open commit. After human approval, moving to the next review unit means updating both refs to its parent/candidate pair. Use expected-old-value checks and a Git ref transaction when both change, verify the resulting served diff, and reuse the same server, token and tab. Both endpoints already use movable refs; no startup reconfiguration is needed.

Preserve original comment blob/revision anchors; updating the review ref does not relabel old comments. A stable ref is a presentation pointer, not evidence of review approval by itself.

## Restart only when necessary; retain custody

Changing server configuration or recovering a failed server may still need a restart. It should not be the normal way to present an amended commit. Preserve logs/comments, freshly identify the owned process on its machine, close only that instance gracefully, and observe closure before reusing its port. Historical process/job identifiers or URLs are pickup hints, not future signal authority or proof of remote reachability.

Prefer a stable port when practical; announce any address change. If a restart rotates the token, give Michael the new authenticated link directly in this private chat and reuse the existing context's tab. Keep only the intended review instances running, with one clearly identified instance per active review context rather than duplicate instances of the same review.

Record the current server's identity, cwd, port, log and feedback paths, review base/SHA and intentional ongoing custody in the project pickup—not in this reusable skill. Don't claim a Nu job handle belongs to a different session or that killing a job proves its external process exited. No reboot service is implied by a local review trial.
