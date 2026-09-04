#!/usr/bin/env python3
"""Diff a rewritten note against its baseline for LOST facts.

The rewrite is allowed to change prose freely. It is not allowed to drop
numbers, links, or the hedges that mark a claim as inference. This extracts
those three classes from the baseline and reports which no longer appear.

Usage: fact_survival.py <baseline.md> <current.md>
"""
import re
import sys

# Numbers with their unit/suffix attached, so "160 dims" and "160" are distinct
# enough to notice, but we normalize whitespace and case for matching.
NUM = re.compile(r'\d[\d,_.]*\s*(?:%|B/param|GiB|GB|B\b|t/s|×|x\b|-bit)?', re.I)
URL = re.compile(r'https?://[^\s)\]<>]+')
WIKI = re.compile(r'\[\[([^\]]+)\]\]')
HEDGES = ['probably', 'likely', 'suspect', 'appears', 'seems', 'may ', 'might',
          'unverified', 'unconfirmed', 'claims', 'claimed', 'reportedly',
          'we think', 'i think', 'guess', 'estimate', 'roughly', 'approximately',
          'assume', 'inference', 'hypothesis', 'if ', 'would ', 'untested',
          'not verified', 'by his own', 'says ', 'per his']


def norm(s):
    return re.sub(r'\s+', ' ', s).strip().lower().rstrip('.')


def facts(text):
    nums = {}
    for m in NUM.finditer(text):
        t = norm(m.group(0))
        if t and not re.fullmatch(r'[\d,_.]+', t) or len(t.replace(',', '')) >= 2:
            nums.setdefault(t, 0)
            nums[t] += 1
    return {
        'numbers': nums,
        'urls': set(URL.findall(text)),
        'wikilinks': set(norm(w) for w in WIKI.findall(text)),
        'hedges': {h: len(re.findall(re.escape(h), text, re.I)) for h in HEDGES},
    }


def main(base_path, cur_path):
    base = open(base_path).read()
    cur = open(cur_path).read()
    b, c = facts(base), facts(cur)
    cur_norm = norm(cur)

    print(f'=== {cur_path} ===')
    print(f'  size: {len(base)} -> {len(cur)} chars '
          f'({100 * (len(cur) - len(base)) / len(base):+.0f}%)')

    lost = [n for n in b['numbers'] if n not in cur_norm]
    print(f'\n  NUMBERS lost ({len(lost)} of {len(b["numbers"])}):')
    for n in sorted(lost):
        # show the baseline line it came from, for judgment
        line = next((l.strip() for l in base.splitlines() if n in norm(l)), '')
        print(f'    - {n!r}   <- {line[:140]}')
    if not lost:
        print('    (none)')

    for key in ('urls', 'wikilinks'):
        gone = b[key] - c[key]
        print(f'\n  {key.upper()} lost ({len(gone)} of {len(b[key])}): '
              f'{sorted(gone) if gone else "(none)"}')

    print('\n  HEDGES (baseline -> current):')
    for h, n in b['hedges'].items():
        m = c['hedges'][h]
        if n and m < n:
            print(f'    - {h!r}: {n} -> {m}   DROPPED {n - m}')

    new_nums = [n for n in c['numbers'] if n not in norm(base)]
    print(f'\n  NUMBERS that are NEW (possible invention) ({len(new_nums)}):')
    for n in sorted(new_nums):
        line = next((l.strip() for l in cur.splitlines() if n in norm(l)), '')
        print(f'    + {n!r}   <- {line[:140]}')
    if not new_nums:
        print('    (none)')
    print()


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
