---
name: skepsis
description: "On-demand browser diff reviews with Skepsis (oxidecomputer/skepsis). Use when setting up, updating, or sharing a live Skepsis code review tab."
---

# Skepsis Review Workflow (`0.5+`)

[Skepsis](https://github.com/oxidecomputer/skepsis) serves a local browser UI for reviewing Git or `jj` diffs and sending structured inline comments back to disk. Verify installation and flags on the host first (`which skepsis`, `skepsis --version`, `skepsis --help`).

## 1. Movable Git Refs (`refs/review/<context>/{base,current}`)

Skepsis re-evaluates its `--from` and `--to` revision arguments on poll/refresh rather than freezing SHAs at startup. Starting against **dedicated per-effort refs** lets one server, port, auth token, and browser tab survive commit amendments and multi-slice reviews without exposing half-edited working trees:

1. Before starting Skepsis, point `refs/review/<context>/base` at the parent commit and `refs/review/<context>/current` at the committed revision ready for review (`git update-ref refs/review/<slug>/base <sha>`), verifying `git diff refs/review/<slug>/base..refs/review/<slug>/current` includes any newly added files.
2. Launch Skepsis on loopback (`127.0.0.1`) with `--from refs/review/<slug>/base --to refs/review/<slug>/current`. Avoid pointing `--to` at a moving `HEAD` that is actively being edited.
3. When follow-up commits or amendments are ready, advance `refs/review/<slug>/current` (with expected-old-SHA check) and let the existing browser tab refresh in place rather than spawning new servers or tabs. Give concurrent review efforts distinct `<slug>` names and loopback ports.

## 2. Per-Run Secret URLs & Reachability Honesty

- **Private delivery only:** Skepsis prints a startup URL containing a per-run access token fragment (`X-Skepsis-Token`). Bare `http://host:port/` returns `200` HTML yet fails API calls with **No valid access token**. Deliver the full clickable authenticated URL **strictly in private DM** — never paste the token or tokenized URL into shared feeds, commits, or public logs.
- **Local vs. remote reviewers:** Loopback (`127.0.0.1:<port>`) only works on the same machine, and Skepsis `0.5.x` serves root-relative assets/APIs (with a loopback `Host`/`Origin` check on `Send` and no base-path flag). Confirm whether the reviewer is local or remote before presenting a link, and never weaken `Host`/`Origin` security gates to force a path-mounted proxy.

## 3. Comment Capture & Clean Process Detachment

- **Prefer `Send` to a JSON file over source-file markers:** Skepsis's `Comment` action writes inline markers into working-tree files, which collides with active edits. Configure `Send` to append JSON records (file, line range, blob SHA, comment text) to an owned feedback path, consuming stdin strictly as data — never interpolating comment text into shell commands.
- **Detaching from persistent MCP/tool shells:** Spawn Skepsis via `launchd` or detached file-descriptor redirection (`stdio: ["ignore", outFd, errFd]` + `.unref()`, never `sh -c 'nohup ... &'` — see `skill:nushell` §4), and verify via `lsof -n -P -p <pid>` that `fd 0/1/2` hold no parent `PIPE`/`unix` descriptors.
