#!/usr/bin/env python3
"""Compare every archived section against its live-log original, byte for byte.

The archive header promises the sections are "byte-identical to their live-log
originals". A spot check found 6 of 7 exact and one differing by a single
character (~23 s -> ~22 s). One-in-seven is not a rate; this measures the rate.

Read-only. Touches nothing.
"""
import os
import re

K = '/Users/nir/notes/knowledge/'
LIVE = K + 'Prime Curation Log.md'
ARCH = K + 'Prime Curation Log — W34 (2026-08-20..24).md'


def sections(path):
    """-> dict heading -> body text. H1 ('# ') delimits entries in this log."""
    with open(path, encoding='utf-8') as fh:
        text = fh.read()
    parts = re.split(r'^(# .*)$', text, flags=re.M)
    out = {}
    # parts = [preamble, head1, body1, head2, body2, ...]
    for i in range(1, len(parts) - 1, 2):
        out[parts[i].strip()] = parts[i + 1]
    return out


live = sections(LIVE)
arch = sections(ARCH)

print(f'live log sections:  {len(live)}')
print(f'archived sections:  {len(arch)}\n')

exact = drifted = missing = 0
for head, abody in arch.items():
    if head not in live:
        print(f'MISSING FROM LIVE  {head[:78]}')
        missing += 1
        continue
    lbody = live[head]
    if lbody == abody:
        exact += 1
        continue
    drifted += 1
    # Locate every differing position, not just the first.
    n = min(len(lbody), len(abody))
    diffs = [i for i in range(n) if lbody[i] != abody[i]]
    print(f'DRIFTED  {head[:74]}')
    print(f'   live {len(lbody)} chars / archive {len(abody)} chars, '
          f'{len(diffs)} differing position(s)'
          + ('' if len(lbody) == len(abody) else '  [LENGTH DIFFERS]'))
    for i in diffs[:6]:
        lo, hi = max(0, i - 34), i + 34
        print(f'     @{i}  live: ...{lbody[lo:hi]!r}...')
        print(f'           arch: ...{abody[lo:hi]!r}...')

total = exact + drifted
print(f'\nexact:   {exact}/{total}')
print(f'drifted: {drifted}/{total}'
      + (f'  = {100*drifted/total:.0f}% of copied sections' if total else ''))
if missing:
    print(f'missing: {missing} archived section(s) have no live counterpart')
