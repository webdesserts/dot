#!/usr/bin/env python3
"""Iris's test, mechanized: is a plan note a ruling's ONLY HOME, or just a citation?

She's right that "mentions a ruling" overcounts. But the distinction has a
syntactic shape she didn't exploit:

  HOME    - the ruling is an AUTHORED SECTION here (a heading declares it).
            Deleting the note destroys the ruling.
  CITED   - prose mentions a ruling AND carries a pointer to where it lives
            (feed #NNNN, autonomy/t:NN, m:<hash>, a wikilink). Safe to delete;
            you lose an index, not the record.
  ORPHAN  - prose asserts a ruling with NO pointer anywhere on the line.
            Nobody has counted these. This is the dangerous middle: it may be
            a unique record, and nothing marks it as one.

The ORPHAN count is the actual output of interest. HOME is what Iris found by
reading; CITED is what she correctly discounted; ORPHAN is the gap between her
77-112 "to triage" and her 4/30 "unambiguous residue".
"""
import os
import re
import sys
from collections import Counter

PLANS = '/Users/nir/notes/plans'

# Governance-sense ruling markers. "binding"/"ruled" need care -- see CODE_SENSE.
MARKER = re.compile(
    r'⚖️|\bADJUDICATED\b|\bBINDING\b|\bbinding\b|\bruled\b|\bRULED\b'
    r'|\bratified\b|\bMichael,? (?:verbatim|ruled|proposes)\b|\bhis ruling\b'
    r'|\bruling\b',
    re.IGNORECASE)

# "binding" in the code sense -- JS bindings, parameter binding, AnchorBinding,
# keybindings, DOM bindings. These are NOT governance and must not inflate.
CODE_SENSE = re.compile(
    r'(?:`[^`]*bind|bind\w*`|::\w*[Bb]ind|[Bb]indings?\b(?=\s*(?:in|for)?\s*`)'
    r'|(?:js|dom|api|plugin|parameter|selector|anchor|key|data|tauri|web_sys)'
    r'[- _]?bind|bind\w*\s*(?:style|references)|verify_anchor_binding)',
    re.IGNORECASE)

# A pointer to a ruling's home somewhere else.
POINTER = re.compile(
    r'#\d{3,}'                      # feed #2404, #2400
    r'|\b[a-z]+/[tpom]:\d+'         # autonomy/t:231
    r'|\bm:[0-9a-z]{6,}'            # message hash
    r'|\[\[[^\]]+\]\]'              # wikilink
    r'|\bfeed[: ]#?\d+'             # feed #NNNN / feed:NNNN
    r'|\b(?:ui|app|autonomy|memory)#\d+'   # lane#NN
    r'|https?://')


# A markdown heading needs '#'* followed by a SPACE. Without this, '#39 stands
# as ruled' (a feed-id reference at line start) was being read as a heading.
HEADING = re.compile(r'^\s{0,3}#{1,6}\s')

# Headings that LOOK authored but name their real home elsewhere: criteria
# recaps (home = the card), verbatim pulls from the live record, "how it maps
# onto" pointers, and forks still AWAITING a ruling rather than recording one.
NOT_A_HOME = re.compile(
    r'recap|on the card|from the live|plan to these|how it maps'
    r'|NOT ratified|open forks?\b|unchanged from', re.IGNORECASE)


def classify_line(line):
    """-> 'HOME' | 'CITED' | 'ORPHAN' | None"""
    m = MARKER.search(line)
    if not m:
        return None
    # Strip code-sense binding hits; if that was the ONLY marker, drop the line.
    if CODE_SENSE.search(line):
        stripped = CODE_SENSE.sub('', line)
        if not MARKER.search(stripped):
            return None
    if HEADING.match(line):
        # An authored ruling section -- unless it names its home elsewhere.
        return 'CITED' if NOT_A_HOME.search(line) else 'HOME'
    if POINTER.search(line):
        return 'CITED'
    return 'ORPHAN'


def scan(path):
    out = Counter()
    orphans = []
    homes = []
    with open(path, encoding='utf-8', errors='replace') as fh:
        for i, line in enumerate(fh, 1):
            c = classify_line(line)
            if c:
                out[c] += 1
                if c == 'ORPHAN':
                    orphans.append((i, line.strip()))
                elif c == 'HOME':
                    homes.append((i, line.strip()))
    return out, orphans, homes


def selftest():
    """Mutation-test every branch before trusting a single number."""
    cases = [
        ('## ⚖️ ADJUDICATED (Iris) — BINDING', 'HOME'),
        ('## Ratified principle (Michael, verbatim intent)', 'HOME'),
        ('Scope per Michael\'s ruling (feed #2404/#2406)', 'CITED'),
        ('Michael proposes `data-ui` namespacing (#2400)', 'CITED'),
        ('per the ruling in [[Address System Proposal]]', 'CITED'),
        ('resolved per autonomy/t:231', None),          # no ruling marker
        ('Michael ruled this stays deferred.', 'ORPHAN'),
        ('This is BINDING on all slice briefs.', 'ORPHAN'),
        ('the `q` binding above for the queue', None),   # code sense only
        ('no `web_sys`/DOM bindings, no allocator', None),
        ('`AnchorBinding::ReAnchor` skips the check', None),
        ('variations only on parameter binding style', None),
        ('plain prose with no markers at all', None),
        ('its non-scroll CRs stay binding under their own note', 'ORPHAN'),
        # --- new branches: heading needs a space; recaps are not homes ---
        ('#39 stands as ruled (>=1, mutable, catch-all backfill)', 'ORPHAN'),
        ('## Criteria (ratified on the card)', 'CITED'),
        ('## Ratified criteria (recap)', 'CITED'),
        ('## Criteria (VERBATIM from the live ratified record)', 'CITED'),
        ('## Open forks for the Orchestrator\'s ruling', 'CITED'),
        ('## How it maps onto the ratified design', 'CITED'),
        ('## Peri\'s derivations — NOT ratified', 'CITED'),
        ('## Adjudication (orchestrator — BINDING on the worker)', 'HOME'),
        ('### ⚖️ ADJUDICATED (Iris, under grant) — BINDING', 'HOME'),
    ]
    bad = []
    for text, want in cases:
        got = classify_line(text)
        if got != want:
            bad.append((text, want, got))
    if bad:
        print('SELFTEST FAILED — classifier is not trustworthy:')
        for t, w, g in bad:
            print(f'  {t!r}\n    want={w} got={g}')
        sys.exit(1)
    print(f'selftest: {len(cases)}/{len(cases)} branches correct\n')


selftest()

files = sorted(f for f in os.listdir(PLANS) if f.endswith('.md'))
tot = Counter()
per_file = []
all_orphans = []
for f in files:
    c, orph, homes = scan(os.path.join(PLANS, f))
    tot.update(c)
    if c:
        per_file.append((f, c))
    if orph:
        all_orphans.append((f, orph))

n_home = sum(1 for f, c in per_file if c['HOME'])
n_orphan_only = sum(1 for f, c in per_file if c['ORPHAN'] and not c['HOME'])
n_cited_only = sum(1 for f, c in per_file
                   if c['CITED'] and not c['HOME'] and not c['ORPHAN'])

print(f'plans scanned:            {len(files)}')
print(f'plans with any marker:    {len(per_file)}')
print()
print(f'  HOME (authored ruling):     {n_home:>4} notes   '
      f'{tot["HOME"]:>4} lines  -> DELETING DESTROYS THE RULING')
print(f'  ORPHAN, no authored home:   {n_orphan_only:>4} notes   '
      f'{tot["ORPHAN"]:>4} lines  -> UNCOUNTED; may be a unique record')
print(f'  CITED only:                 {n_cited_only:>4} notes   '
      f'{tot["CITED"]:>4} lines  -> safe; pointer resolves elsewhere')
print()
print('=== ORPHAN sample (assert a ruling, point nowhere) ===')
shown = 0
for f, orph in all_orphans:
    if shown >= 12:
        break
    ln, text = orph[0]
    print(f'  [{f[:44]:<44}:{ln}] {text[:96]}')
    shown += 1
