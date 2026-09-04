#!/usr/bin/env python3
"""Resident parameter split for Flash-Next UD-Q4_K_XL.

Settles the '125B + 51.84B' line in §Two things absent, which still carries the
pre-correction n-gram figure. Counts PARAMS (not bytes) so the three numbers in
the note -- total resident, n-gram table, everything else -- have to add up.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gguftensors import parse

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'fn')

total = 0
ngram = 0
ntensors = 0
blocks = set()
mtp_like = []

for s in sorted(f for f in os.listdir(D) if f.endswith('.gguf')):
    kv, ts = parse(os.path.join(D, s))
    for t in ts:
        els = 1
        for x in t['dims']:
            els *= x
        total += els
        ntensors += 1
        name = t['name']
        if 'per_layer_token_embd' in name:
            ngram += els
        if name.startswith('blk.'):
            blocks.add(int(name.split('.')[1]))
        if any(k in name.lower() for k in ('mtp', 'nextn', 'draft', 'eagle')):
            mtp_like.append(name)

rest = total - ngram
print(f'tensors censused : {ntensors}')
print(f'blocks           : {min(blocks)}-{max(blocks)}  (count {len(blocks)})')
print(f'MTP-like tensors : {mtp_like or "NONE"}')
print()
print(f'total resident   : {total:>15,}  = {total/1e9:.2f}B')
print(f'  n-gram table   : {ngram:>15,}  = {ngram/1e9:.2f}B')
print(f'  everything else: {rest:>15,}  = {rest/1e9:.2f}B')
print()
print(f'check: {rest/1e9:.2f} + {ngram/1e9:.2f} = {(rest+ngram)/1e9:.2f}B')
print(f"note's current claim: 125B + 51.84B = {125 + 51.84:.2f}B")
print(f"note's stated total : 176.94B  -> delta {total/1e9 - 176.94:+.2f}B")
