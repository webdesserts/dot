#!/usr/bin/env python3
"""Did a note's facts survive ANYWHERE in the vault, not just in that note?

The per-note checker (fact_survival.py) asks "is this fact still in this file".
That question became wrong the moment consolidation was authorised: content is
allowed to MOVE between notes now, so a fact migrated to a better home reads as
LOST to the old checker. This one classifies three ways instead:

  INTACT  - still in the note it started in
  MOVED   - gone from that note, but present elsewhere in the vault (says where)
  LOST    - not found anywhere

Only LOST is a finding. MOVED is the consolidation working.

CALIBRATION, learned by defeat-checking this script against a deliberately
truncated note (2026-09-01): it correctly caught all 5 dropped facts, but
classified them MOVED rather than LOST — and one reason was pure coincidence.
`3478` turned up in LiveKit.md because 3478 is the STUN port, not because
anything migrated there. So:

  **MOVED is a triage bucket, not a verdict.** Short numbers and common
  wikilinks collide across unrelated notes constantly, which means a genuinely
  dropped fact can hide in MOVED. Read the MOVED list; don't just skim LOST.

LOST is trustworthy in the other direction: if a string appears nowhere in
1,200+ notes, it really is gone.

Usage: fact_survival_vault.py <baseline.md> <current-path-in-vault> [more pairs...]
"""
import os
import re
import sys

VAULT = '/Users/nir/notes'

NUM = re.compile(r'\d[\d,_.]*\s*(?:%|B/param|GiB|GB|B\b|t/s|×|x\b|-bit)?', re.I)
URL = re.compile(r'https?://[^\s)\]<>]+')
WIKI = re.compile(r'\[\[([^\]]+)\]\]')


def norm(s):
    return re.sub(r'\s+', ' ', s).strip().lower().rstrip('.')


def numbers(text):
    """Distinct normalized numeric facts worth tracking."""
    out = set()
    for m in NUM.finditer(text):
        t = norm(m.group(0))
        if not t:
            continue
        # Skip bare 1-digit noise; keep anything with a unit or >=2 digits.
        if re.fullmatch(r'[\d,_.]+', t) and len(t.replace(',', '').replace('.', '')) < 2:
            continue
        out.add(t)
    return out


def load_corpus():
    """-> {relative_path: normalized_text} for every note in the vault."""
    corpus = {}
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if d not in ('.sync', '.obsidian', '.git')]
        for fn in files:
            if not fn.endswith('.md'):
                continue
            p = os.path.join(root, fn)
            try:
                with open(p, encoding='utf-8', errors='replace') as fh:
                    corpus[os.path.relpath(p, VAULT)] = norm(fh.read())
            except OSError:
                pass
    return corpus


def where(fact, corpus, exclude):
    """Which notes (other than `exclude`) contain this fact."""
    return [p for p, t in corpus.items() if p != exclude and fact in t]


def selftest():
    """Mutation-test the classifier before trusting a single verdict."""
    corpus = {
        'a.md': norm('the answer is 42 GiB and stable'),
        'b.md': norm('moved here: 1,422 documents'),
    }
    cases = [
        # (fact, current_text_of_a, expected_class)
        ('42 gib', 'the answer is 42 GiB', 'INTACT'),
        ('1,422 documents', 'nothing numeric here', 'MOVED'),
        ('99 bottles', 'nothing numeric here', 'LOST'),
    ]
    bad = []
    for fact, cur_text, expected in cases:
        cur = norm(cur_text)
        if fact in cur:
            got = 'INTACT'
        elif where(fact, corpus, 'a.md'):
            got = 'MOVED'
        else:
            got = 'LOST'
        if got != expected:
            bad.append((fact, expected, got))
    if bad:
        print('SELFTEST FAILED — classifier not trustworthy:')
        for f, e, g in bad:
            print(f'  {f!r}: want {e}, got {g}')
        sys.exit(1)
    print(f'selftest: {len(cases)}/{len(cases)} classes correct\n')


def check(baseline_path, current_rel):
    with open(baseline_path, encoding='utf-8') as fh:
        base = fh.read()
    corpus = load_corpus()
    cur = corpus.get(current_rel)
    if cur is None:
        print(f'!! {current_rel} not found in vault')
        return

    facts = {'number': numbers(base),
             'url': set(URL.findall(base)),
             'wikilink': set(norm(w) for w in WIKI.findall(base))}

    print(f'=== {current_rel} (baseline {os.path.basename(baseline_path)}) ===')
    tally = {'INTACT': 0, 'MOVED': 0, 'LOST': 0}
    moved, lost = [], []

    for kind, items in facts.items():
        for f in items:
            probe = norm(f) if kind != 'url' else f
            if probe in cur:
                tally['INTACT'] += 1
            else:
                homes = where(probe, corpus, current_rel)
                if homes:
                    tally['MOVED'] += 1
                    moved.append((kind, f, homes[:3]))
                else:
                    tally['LOST'] += 1
                    line = next((l.strip() for l in base.splitlines()
                                 if probe in norm(l)), '')
                    lost.append((kind, f, line[:130]))

    total = sum(tally.values())
    print(f'  {total} facts tracked: '
          f'{tally["INTACT"]} intact, {tally["MOVED"]} moved, '
          f'**{tally["LOST"]} LOST**')

    if moved:
        print(f'\n  MOVED (consolidation working, not a finding):')
        for kind, f, homes in sorted(moved)[:25]:
            print(f'    {kind:9} {f!r} -> {", ".join(homes)}')
        if len(moved) > 25:
            print(f'    ... and {len(moved) - 25} more')

    print(f'\n  LOST (the only findings here):')
    for kind, f, line in sorted(lost):
        print(f'    {kind:9} {f!r}\n              <- {line}')
    if not lost:
        print('    (none)')
    print()


if __name__ == '__main__':
    selftest()
    args = sys.argv[1:]
    for i in range(0, len(args), 2):
        check(args[i], args[i + 1])
