---
name: nushell
description: "Idiomatic Nushell (0.117+) for interactive/MCP sessions and scripts: Bash/JS-to-Nushell mechanics, quoting and interpolation, structured pipelines, external process handling, and Autonomy ctx composition."
---

# Nushell (`0.117+`)

Interactive and MCP Nushell evaluators (such as Autonomy's `nu_eval`) run inside a persistent Nushell session. Two engine mechanics shape how every command block behaves:

1. **Whole-block AST parse:** Nushell parses and type-checks the **entire script before line 1 executes** — a single Bash operator or invalid escape anywhere in the block aborts the whole call with zero side effects.
2. **Pipeline return value vs. stdout:** Evaluators return the **final pipeline value** as structured data (`print` writes to stdout and evaluates to `[]`). Ending a block with a compact record, table, or `str join "\n"` keeps outputs exact and avoids large-output truncation (`>16 KB` collapses to `$last_nu_output` in Autonomy).

## 1. Why POSIX Bash & JS Habits Fail (and What Nushell Uses Instead)

- **Statement chaining & booleans:** Nushell reserves `&&` and `||` as parse errors to avoid conflating shell exit-code short-circuiting with boolean logic. Chain sequential statements with `;` or a newline; inside expressions (`if`, `where`), boolean operators are `and`, `or`, `not`.
- **External commands & exit codes (`^` + `complete`):**
  - Prefix external binaries with `^` when shadowing Nushell builtins (`^find`, `^sort`, `^kill`, `^open`, `^cp`, `^mv`, `^rm`) or capturing exit codes:
    ```nu
    let r = (^node --test packages/harness/test/ctx-module.test.ts | complete)
    {exit: $r.exit_code, tail: ($r.stdout | lines | last 15 | str join "\n"), err: $r.stderr}
    ```
  - Uncaught non-zero external exits abort the pipeline. Because **`^rg`, `^grep`, and `^diff` exit `1` when zero matches/differences are found**, pipe them to `| complete` whenever empty matches are normal and inspect `$r.exit_code`.
  - `complete` only wraps external OS processes (`^cmd`). Internal Nushell/harness commands (`ctx`, `tools`, `web`, `notifications`, `timer`, `alarm`, `def` functions) report failures as structured Nushell errors — catch expected failures with `try { ... } catch {|e| $e.msg }`.
- **Redirection:** Nushell spells stream redirection explicitly (`out+err> file.log` / `o+e>`, `err> /dev/null` / `e>`) or captures streams via `| complete`; POSIX `2>&1`, `&>`, and `2>/dev/null` fail at parse time.
- **Quoting & regex escapes:**
  - Double quotes `"..."` validate backslash escapes at **parse time** and reject regex/Markdown sequences like `\?`, `\.`, `\[`, `\d`, `\s`, and `` \` ``.
  - Single quotes `'...'` treat backslashes literally (`\'` is invalid), and POSIX quote-splicing (`'it'"'"'s'`) is a syntax error.
  - Raw strings (`r#'...'#` or `r###'...'###`, using more `#` signs than any `r#'...'#` literal inside the body) accept apostrophes, quotes, regexes, JSON, and code fences verbatim with zero escaping. Default to `'...'` for simple regexes and `r#'...'#` for multi-line prose or code.
- **String interpolation (`$"..."`):**
  - Bare `$var` inside words (`file:$p`) stays literal (`"file:$p"`). Inside `$"..."`, **every `(...)` is parsed and evaluated as a Nushell expression**: `$"file:($p)"` and `$"($f)#2.1"` interpolate cleanly, whereas prose containing `(parenthetical remarks)` inside `$"..."` fails to parse as code — keep prose in `r#'...'#`.
- **Bindings & mutation (`let` vs. `mut`):**
  - `let x = ...` is immutable and persists across calls in a persistent session when serializable (`<1 MB`).
  - `mut x = ...` (never `let mut`) allows local `$x = ...` reassignment within the current block and does not persist across calls. Because `mut x = null` infers type `nothing`, annotate `mut x: any = null` when assigning a record or list later.
- **Finding & reading files:**
  - Builtin `ls` has no `-r` flag and builtin `find` filters tables rather than directories — walk files with bounded `glob "packages/*/src/**/*.ts"` (avoiding `node_modules`/`target`) or `^find packages -type f`.
  - `open` parses `.json`, `.toml`, `.yaml`, `.csv`, and `.md` into structured Nushell values; pass `open --raw` when raw text is intended.

## 2. Structured Pipelines: Inspect Shapes Before Projecting

1. **Discover commands & flags:** Check `version`, `help <command>`, `scope commands | where name =~ '^http'` (or `help ctx <verb>` / `tools ls` in Autonomy); use `which` for external binaries.
2. **Inspect unfamiliar records before `select` / `get`:** `select col` throws `column_not_found` when `col` is missing. Check `$val | describe`, `$val | columns`, or `$rows | first` before projecting unfamiliar data, reserving optional cell paths (`$row.field?`, `get -o field`, `select -o a b`) for fields whose absence is genuinely part of the schema.
3. **Scalar vs. list boundaries:** `first` / `last` unwrap a single element (returning `nothing` on empty input, which surfaces downstream when indexing or projecting — guard empty pipes or use `default`); `first 1` / `last 1` return a 1-element list/table.
4. **Filter & aggregate in Nu before returning:** Use `where`, `get`, `select`, `insert`, `upsert`, `reject`, `group-by`, `transpose`, `math sum`, `each`, and `par-each --threads N` so only the distilled result returns to context.

## 3. Autonomy Harness Composition (`ctx` & Multi-Line Edits)

When running inside Autonomy's `nu_eval` with `ctx` mounted, Section 2 artifacts persist cleanly across rounds while raw shell output accumulates in `history`:

- **Mount edit/review targets in Section 2 (`ctx load` over shell slicing):** Prefer `ctx load <path> -f "pattern"` (1-hop mount + unfold by substring or `/regex/flags`) or `ctx read <path> | where title =~ '...' | ctx load` over dumping `open --raw`, `^sed -n`, `^cat`, or `^rg` file slices into `history` (and avoid standalone `ctx read <path> -c` for the same reason).
- **Raw-string & scratchpad edits:** Pass `r#'...'#` / `r###'...'###` directly to `ctx edit <path> --old r#'...'# --new r#'...'#` (which works on folded or unmounted files and auto-mounts the edited section) or pipe `$text | ctx edit a.md --old "old"`. For multi-KB documents or long feed posts, compose in `scratch:draft` rather than one giant JSON tool call (`ctx write notes:plans/foo.md --from scratch:draft`, or `tools feeds post (ctx read scratch:draft -c | get content | str join "\n") --feed <slug>`, then `ctx unload scratch:draft`).
- **Selectors, flat files & frozen mounts:** `-S` takes a scalar or list (`-S 2.1`, `-S Store.load`, `-S [2.1 3]`, `-S 1..3`), `--lines` takes Nu ranges (`10..40`) or strings (`"L10..40"`), and multi-word `ctx search` defaults to `AND` (`OR` / `|` for union). Flat files without AST/heading structure (`.nu`, `.toml`, `.txt`, `.jsonl`) report `sections: 0` — reveal windows via `ctx load <path> -f "pattern"` or `ctx expand <path> --lines 1..80`. Files mounted without `--live` stay frozen across external shell writes (`stale: true` in `ctx ls`); refresh with `ctx load <path> --sync`.
- **Phase transitions & history hygiene:** Fold or unmount finished `src/` files (`ctx collapse <file>` / `ctx unload <file>`) when shifting to `test/` files. `ctx read history | where hidden_by == null | ctx unload` hides finished prior turns; to prune older completed rounds of the active turn at a phase boundary (after recording `file:line` findings in `WORKING_MEMORY.md` or `scratch:effort`), keep the last 2 completed rounds + running round visible via `ctx read history --rounds | where hidden_by == null | drop 3 | ctx unload`. On `ctx turns`, pass `--rounds` when `--from`/`--to` filter by round ID rather than turn ID.

## 4. Environment, URLs, HTTP & Detached Processes

- **Scoped environment:** Prefer `with-env {CI: 'true'} { ^npm test | complete }` over mutating `$env.NAME = ...`, which persists for the rest of the session. Never echo raw `$env` or secret values into tool output.
- **Paths & URLs:** Join paths with `path join`. Encode individual URL path segments with `$seg | url encode --all` (plain `url encode` leaves `/` and `:` unencoded). Check `help http get` (`--full`, `--max-time 10sec`, `--allow-errors`) before assuming flags.
- **Detached background processes:** Avoid `sh -c 'cd dir && nohup cmd >out 2>err &'` inside persistent MCP/tool shells — the backgrounded POSIX subshell inherits the parent shell's stdout/stderr pipes and prevents tool calls or session reloads from closing cleanly. Prefer an OS service manager (`launchd` / `systemd`) or spawn directly with `detached: true`, redirected file descriptors (`['ignore', outFd, errFd]`), and `.unref()`. Note that Nu `job spawn` jobs do not trigger Autonomy turn wakes (use `timer` / `alarm`).
