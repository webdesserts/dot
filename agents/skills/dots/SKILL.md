---
name: dots
description: "Dotfile management with dots-cli (0.5.4+). Use when working in ~/.dots/, editing Dot.toml symlink maps, syncing shared skills/configs, or handling shared vs. machine-specific branches."
---

# dots (`dots-cli 0.5.4+`)

Dotfiles across hosts are managed by [dots-cli](https://github.com/webdesserts/dots-cli), which symlinks live git working trees under `~/.dots/` into `$HOME` and `~/.config/`. Run `dots --help` or `dots <subcommand> --help` when checking flags.

## 1. Repository Layout & Symlink Mechanics

Each dot under `~/.dots/<name>/` has a `Dot.toml` mapping target paths to paths inside that repo, tracked in `~/.dots/dot-footprint.toml`:

- **`webdesserts`** (`webdesserts/dot.git`, public): Nushell/zsh/bash config, git, editor & Zellij config, shared agent skills (`agents/skills` -> `~/.config/agents/skills`), and shared scripts.
- **`webdesserts-private`** (`webdesserts/dot-private.git`, private): SSH config, work scripts, `*.env` secrets, and host-specific launchers (`scripts/rhea.nu`).

```bash
dots list                 # installed dots on this machine
dots status               # git status across installed dots
dots path <dot>           # filesystem path of a dot repo
dots install --dry        # preview link creations, updates, and footprint removals
dots install              # apply Dot.toml links and prune removed footprint entries
```

Because `Dot.toml` often links **entire directories** (such as `"~/.config/agents/skills" = "agents/skills"`):

- **Adding/editing files inside an already-linked directory** (e.g., creating or updating `agents/skills/<name>/SKILL.md`) takes effect on disk immediately without re-running `dots install`. Only adding, renaming, or removing a `[link]` key in `Dot.toml` needs `dots install --dry` -> `dots install`.
- **Working-tree coupling:** Symlinks point directly at the checked-out working tree, so switching branches in `~/.dots/*` immediately mutates the host's live config. Use `git worktree add` (in `$TMPDIR`) if you ever need to inspect another branch without disturbing live symlinks.

## 2. Shared (`main`) vs. Host-Specific (`rhea`) Changes

- Most hosts (`umbra`, `charon`) run `main` directly.
- **`rhea`** (corporate MDM laptop) maintains a local, unpushed `rhea` branch consisting of **one squashed override commit on top of `main`** (holding corporate model limits, launchers, and work overrides).
- **Shipping shared changes:** Commit on `main` (`git fetch` + `git rebase origin/main` first if remote moved), push `origin/main`, run `dots install --dry` -> `dots install` if `Dot.toml` changed, and notify peer hosts so `rhea` can `git fetch && git rebase main` under its single override commit.

## 3. How Running Tools Pick Up Updates

- **Autonomy skills (`skill:<name>`):** Unmounted skills resolve fresh from `~/.config/agents/skills/<name>/SKILL.md` on the next `ctx load skill:<name>`; an already-mounted frozen skill refreshes via `ctx load skill:<name> --sync` (or `notifications act stale:skill:<name> sync`).
- **Login-shell exports & `*.env` files:** Require a fresh login shell (or `refresh-env` inside an active Autonomy session).

> Design internals (footprint diffing and symlink cleanup): see [[dots-cli]].
