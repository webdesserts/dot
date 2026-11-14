---
name: docs
description: "Code comments, two-tier library API docs, and Obsidian vault note conventions. Use when writing or reviewing comments, JSDoc/rustdoc, READMEs, docs/api/, or Obsidian vault notes."
---

# Documentation, Comments & Vault Notes

Good documentation reduces how much code or history a reader has to reconstruct, while staying small enough that it actually gets maintained when behavior changes.

## 1. Code Comments & Docstrings: Explain *Why*, Not *What*

Clear names, types, and small functions carry *what* code does. Inline comments and JSDoc/rustdoc earn their space when they capture context the type checker cannot express:

- **Invariants, tradeoffs & protocol quirks:** Explain non-obvious constraints, why an alternative approach failed, performance assumptions, or platform edge cases (e.g., why `spawn` detaches `stdio` or why macOS differs from Linux).
- **Public contracts at the declaration site:** Attach docstrings directly to exported types and functions so editor hover shows purpose, error conditions, and nontrivial limits without forcing callers to read implementation bodies.
- **Living explanations over archaeology:** Describe the contract as it works *now* rather than narrating the debugging story that led there. Mark temporary workarounds with *why* they exist and *what condition* allows removing them.

## 2. Repository Documentation: Single Source of Truth

Duplicating detailed API docs across READMEs, source comments, and external notes guarantees drift:

- **Two-tier library docs:** Keep the root `README.md` concise and welcoming (*what problem the package solves, how to install it, and a minimal quickstart*, linking deeper docs), and place detailed reference pages in `docs/api/*.md` covering strictly exported public APIs.
- **Keep repo APIs in the repo:** Document crate/package APIs alongside the code that implements them rather than mirroring API references into the Obsidian vault.

## 3. Obsidian Vault Notes (`[[Obsidian Writer's Guide]]`)

Vault notes optimize for **concept clarity, wiki-graph discovery, and reuse across projects**:

- **Structure & headings:** Open term/concept notes with a concise blockquote definition (`> Definition...`). Because Obsidian displays the filename as the top-level title, start sections at `##` (avoiding `#` `<h1>` headings) and limit frontmatter to functional fields like `aliases`.
- **Prose over deep bullet trees:** Explain ideas in complete paragraphs; save bullet lists (`<= 2` nesting levels) for genuine comparisons, checklists, or parallel enumerations. Link liberally with `[[WikiLinks]]` so related notes stay connected in the graph.
- **Generic `knowledge/` vs. specific `projects/`:** Keep `knowledge/` notes project-agnostic (reusable explanations of tools, languages, and patterns) and place repo-specific architecture, plans, and post-mortems in `projects/`, `plans/`, or `episodes/`. Before creating a new note or checklist, check whether an existing canonical note already owns the topic and consolidate there.
