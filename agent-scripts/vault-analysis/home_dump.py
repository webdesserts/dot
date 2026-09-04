#!/usr/bin/env python3
"""Every HOME line, so the count can be audited rather than trusted."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ruling_home as R

n = 0
for f in sorted(x for x in os.listdir(R.PLANS) if x.endswith('.md')):
    _, _, homes = R.scan(os.path.join(R.PLANS, f))
    for ln, t in homes:
        n += 1
        print(f'{f[:40]:<40}:{ln:<5} {t[:92]}')
print(f'\ntotal HOME lines: {n}')
