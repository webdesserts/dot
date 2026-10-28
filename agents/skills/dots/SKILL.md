---
name: dots
description: "Dotfile management with dots-cli. Use when working in ~/.dots/, editing Dot.toml files, managing symlinks across machines, or committing shared versus machine-specific config."
---

# dots

Michael's dotfiles are managed by his own [dots-cli](https://github.com/webdesserts/dots-cli). Check `dots --help` and `dots <command> --help` before relying on a flag; the examples below were checked against **dots 0.5.2**.

## The repositories

Each "dot" is a git repository under `~/.dots/` with a `Dot.toml` that maps destinations to files in the repository.

- **`webdesserts`** (public, `webdesserts/dot.git`): shell (nushell, zsh, bash), git, editor settings, scripts, Zellij, the shared agent material in `agents/` (orchestrator doctrine, skills) and pi configuration in `pi/` (settings, agents, extensions, themes).
- **`webdesserts-private`** (private, `webdesserts/dot-private.git`): ssh config, work scripts, `*.env` secrets files, machine launchers such as `scripts/rhea.nu`, and private pi extensions and agents.

Run `dots list` to see what is installed on the current machine; not every machine has every dot.

## Commands

```bash
dots list                 # installed dots
dots status               # git status of every dot
dots path <dot>           # where a dot lives
dots install --dry        # preview the link plan; run this first
dots install              # create, update and clean up links
dots install -f           # also replace pre-existing directories at a destination
dots install --overwrite  # replace a pre-existing dot of the same name
```

`~/.dots/dot-footprint.toml` records every link dots created. `dots install` uses it to remove links that a `Dot.toml` no longer declares, so deleting an entry and reinstalling cleans up after itself.

## Links

```toml
[link]
"~/.pi/agent/settings.json" = "pi/settings.json"
"~/.config/agents/skills" = "agents/skills"
```

A link can target a file or a whole directory. Files added inside a linked directory, such as a new skill under `agents/skills/` or a new agent under `pi/agents/`, appear immediately without reinstalling. Only a **new `Dot.toml` entry** needs `dots install`.

Links point into the **checked-out working tree**. Whatever branch is checked out is the live configuration, so `git checkout` in a dot immediately changes the machine's settings. Keep branch switches brief, or use `git worktree add` when you need to work on another branch for longer.

## Shared versus machine-specific changes

Each machine keeps a local branch named after itself (for example `rhea`) in each dot. That branch is **one squashed commit on top of `main`** holding only machine-specific changes: the default model, `compaction.reserveTokens`, machine launchers and local secrets. It is never pushed.

Generic changes go to `main` and are pushed:

1. Commit the change on `main`, then `git fetch` and rebase onto `origin/main` if it has moved (other machines push too).
2. `git push origin main`.
3. Return to the machine branch and `git rebase main`, keeping it a single commit.
4. Run `dots install --dry`, then `dots install` if a link was added or removed.
5. Tell the other machines' agents what changed and how to pick it up (on the Autonomy feed).

Other machines pick a change up by pulling `main`, rebasing their own machine branch and reinstalling.

When a shared file such as `pi/settings.json` needs a machine-specific value, keep the generic version on `main` and the override in the machine commit. Expect occasional rebase conflicts in that file and resolve them by keeping both intents.

## Picking up changes

Different config is read at different times:

- **pi extensions and skills:** `/reload` picks them up.
- **Tool schemas:** changes such as the pi-subagents `disabledFeatures` need a full pi restart and a new session; a resumed session keeps the schema it already declared.
- **Launcher scripts and `*.env` files:** need a relaunch from a fresh shell.

For the design of dots-cli itself (symlink management, footprint behavior, cleanup algorithm), see [[dots-cli]] in the notes vault.
