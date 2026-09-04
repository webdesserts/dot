#!/usr/bin/env python3
"""What is the one remaining character? A real edit, or my splitter's artifact?"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive_drift import sections, LIVE, ARCH

live, arch = sections(LIVE), sections(ARCH)
for head, abody in arch.items():
    lbody = live.get(head)
    if lbody is None or lbody == abody:
        continue
    print(f'{head}\n')
    print(f'  live  ends: {lbody[-46:]!r}')
    print(f'  arch  ends: {abody[-46:]!r}')
    print(f'\n  live is a prefix-superset of arch? '
          f'{lbody.startswith(abody)}')
    print(f'  difference is trailing whitespace only? '
          f'{lbody.rstrip() == abody.rstrip()}')
    print(f'  extra char(s) in live: {lbody[len(abody):]!r}')
