---
name: dots
description: "Dotfile management with dots-cli. Use when working in ~/.dots/, editing Dot.toml files, or managing symlinks across machines."
---

## dots-cli

**Tool**: `dots` CLI — https://github.com/webdesserts/dots-cli

**IMPORTANT**: Always run `dots --help` or check the GitHub README before using commands. Your knowledge may be outdated.

### Basic Usage

```bash
# List all installed dots
dots list

# Preview changes before applying
dots install --dry

# Install/update symlinks from Dot.toml files
dots install

# Check git status of all dots
dots status

# Get path to a specific dot
dots path <dot-name>
```

### Structure

- **`~/.dots/`** — Root directory for all dotfile repos
- **`dot-footprint.toml`** — Master list of all symlinks (auto-generated)
- **Individual dots** — Each has a `Dot.toml` defining links

### Current Dots

- **velvet** — Neovim configuration
- **webdesserts** — Public dotfiles (shell, git, scripts, vscode, claude)
- **webdesserts-private** — Private dotfiles (ssh, work scripts, credentials)

### Link Format in Dot.toml

```toml
[link]
"~/destination/path" = "source/file/in/repo"
```

---

> For architecture details (symlink management design, footprint behavior, cleanup algorithm), see [[dots-cli]]
