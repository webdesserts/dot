#!/usr/bin/env python3
"""Of the 61 authored rulings in plans/, which are WORLD-AS-IS vs WORLD-AS-IT-WAS?

Michael's bar (2026-09-01): notes carry "higher level information or high
priority information"; their purpose is to spare us digging through the world
state; knowledge notes hold "the world as is" more than "the world as it was".
Under that bar, "not every decision should be consolidated" -- most should be
deleted with the plan.

Reading the 61 HOME lines, the split has a legible shape: **who ruled it.**

  DESIGN   - Michael ruled/ratified it directly. Durable design intent that
             still constrains future work ("never toggle the layout prop",
             "it's just a feed", "sociality is a velocity dial"). Survives the
             arc that produced it -> candidate for a knowledge note.
  DISPATCH - An agent adjudicated it under a grant, at a forecast gate or in
             review, BINDING ON A WORKER for one arc. Once the arc ships, the
             code is the answer. This is exactly Michael's "this specific
             function behaves this way" class -> dies with the plan.

CRITICAL TRAP, and the reason this needs a selftest: many DISPATCH headings
contain the word "Michael" -- as the source of the GRANT, not of the ruling.
"ADJUDICATED (Iris, under Michael's 'you have the wheel' grant)" is Iris
ruling, not Michael. A naive `'Michael' in line` test misclassifies these in
the direction that inflates the durable bucket.

This is a TRIAGE SPLIT, NOT A VERDICT. The same calibration as MOVED in
fact_survival_vault.py: it sorts 61 lines into two piles worth reading, and a
genuinely durable ruling can sit in the DISPATCH pile. Nobody should delete
from this output. Read the piles.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ruling_home as R

# Clauses where Michael is named as GRANTOR or RECIPIENT, not as author. Both
# were caught by reading output, not by the selftest that "passed":
#   - "under Michael's arc grant"        -> he granted; the agent ruled
#   - "ratified here, NOT re-escalated to Michael" -> he never saw it
# The second is the sharper trap: the heading names him precisely to say the
# ruling is *not* his.
NOT_AUTHOR_CLAUSE = re.compile(
    r"under\s+(?:michael'?s?|the|a|his|her)\b[^)]*?\bgrant"
    r"|(?:not\s+)?re-?escalated\s+to\s+michael"
    r"|escalat\w*\s+to\s+michael"
    r"|for\s+michael'?s?\s+(?:call|review|glance|approval)"
    r"|ask\s+michael",
    re.IGNORECASE)

# An agent seat authored it.
AGENT_AUTHOR = re.compile(
    r'\borchestrator\b|\bforecast\b|\breviewer\b|\bplan-review\b'
    r'|\bPeri\b|\bIris\b|\bUmbra\b',
    re.IGNORECASE)

# Michael ruled it himself.
MICHAEL_AUTHOR = re.compile(
    r"\bMichael'?s?\b|\bMICHAEL'?S\b", re.IGNORECASE)


def classify(line):
    """-> 'DESIGN' | 'DISPATCH'"""
    # Strip non-authorship clauses first: inside them, Michael is the grantor
    # or the person NOT consulted -- either way, not the author.
    stripped = NOT_AUTHOR_CLAUSE.sub('', line)
    michael = bool(MICHAEL_AUTHOR.search(stripped))
    agent = bool(AGENT_AUTHOR.search(stripped))
    if michael and not agent:
        return 'DESIGN'
    if agent and not michael:
        return 'DISPATCH'
    if michael and agent:
        # Both named outside a grant clause: an agent folding Michael's ruling.
        # The agent is the author of THIS text -> dispatch.
        return 'DISPATCH'
    # Neither named. Ratified-decision preambles ("do not re-litigate",
    # "the ruling, restated as an invariant set") are design; bare
    # adjudication/correction headings are dispatch.
    # \b is load-bearing on every term: without it `vision` matched inside
    # "Di-vision of labor" and promoted a dispatch heading to DESIGN.
    if re.search(r'\bdo not re-?litigate\b|\bdo not reopen\b|\binvariants?\b'
                 r'|\bvision\b|\bratified principle\b|\bLANDMINE\b'
                 r'|\bMUST-FIX\b',
                 line, re.IGNORECASE):
        return 'DESIGN'
    return 'DISPATCH'


def selftest():
    """Mutation-test the trap cases before trusting a single number."""
    cases = [
        # --- the grant trap: Michael named, agent ruled ---
        ("## ⚖️ ADJUDICATED (Iris, 2026-07-15 night, under Michael's "
         "\"you have the wheel\" grant) — BINDING", 'DISPATCH'),
        ("## Orchestrator adjudications (Peri, 2026-08-07, under Michael's "
         "arc grant — BINDING for this arc)", 'DISPATCH'),
        ("## ⚖️ ADJUDICATED (Iris, 2026-07-16, under the \"you have the "
         "wheel\" grant) — BINDING", 'DISPATCH'),
        # --- Michael genuinely ruling ---
        ('## Ratified principle (Michael, verbatim intent)', 'DESIGN'),
        ("## Michael's UI ruling (2026-08-07) — \"it's just a feed\"", 'DESIGN'),
        ('## Triage turn semantics (all Michael-ruled)', 'DESIGN'),
        ('## Spike 2: z/2D-clearance coupling (MICHAEL\'S RULED INVARIANT)',
         'DESIGN'),
        ("## Intent (Michael's ruling, 2026-08-14, verbatim)", 'DESIGN'),
        ('## The root cluster — ADJUDICATED (Michael, 2026-07-07): build it '
         'as slice 4.2d', 'DESIGN'),
        # --- agent seats, no Michael at all ---
        ('## Adjudication (orchestrator, 2026-07-11 ~02:20 — BINDING on the '
         'worker)', 'DISPATCH'),
        ('#### FORECAST-GATE ADJUDICATIONS (2026-07-18, binding)', 'DISPATCH'),
        ('## Plan-review corrections (reviewer-clusterB-plan, adjudicated '
         '2026-07-08)', 'DISPATCH'),
        ('## ADJUDICATION — BINDING (Peri, 2026-07-15, post forecast-review)',
         'DISPATCH'),
        # --- neither named: fall-through rules ---
        ('## Ratified decisions (do not re-litigate)', 'DESIGN'),
        ('## Ratified decisions this plan is bound by (do not reopen)',
         'DESIGN'),
        ('## The ruling, restated as an invariant set', 'DESIGN'),
        ('## The vision (Michael, verbatim-critical)', 'DESIGN'),
        ('## ⚠️ LANDMINE (binding): never toggle the `layout` prop '
         'conditionally', 'DESIGN'),
        ('## Adjudication record (BINDING, resolved)', 'DISPATCH'),
        ('### Coverage table (binding adjudications)', 'DISPATCH'),
        # --- REGRESSIONS: both of these passed a 20/20 selftest and were
        # only caught by reading the output. Pinned so they cannot return.
        # 1. substring: "vision" inside "Division".
        ('## Division of labor (ratified)', 'DISPATCH'),
        # 2. Michael named precisely to say the ruling is NOT his.
        ('### Adjudicated forks (recommendations — ratified here, not '
         're-escalated to Michael; both land as-specified)', 'DISPATCH'),
        # Guard the fix from over-reaching: a real vision heading still wins.
        ('## The vision (Michael, verbatim-critical)', 'DESIGN'),
        ('## Product vision, restated', 'DESIGN'),
    ]
    bad = []
    for text, want in cases:
        got = classify(text)
        if got != want:
            bad.append((text, want, got))
    if bad:
        print('SELFTEST FAILED — classifier is not trustworthy:')
        for t, w, g in bad:
            print(f'  {t[:88]!r}\n    want={w} got={g}')
        sys.exit(1)
    print(f'selftest: {len(cases)}/{len(cases)} branches correct '
          f'(incl. {3} grant-trap cases)\n')


selftest()

design, dispatch = [], []
for f in sorted(x for x in os.listdir(R.PLANS) if x.endswith('.md')):
    _, _, homes = R.scan(os.path.join(R.PLANS, f))
    for ln, t in homes:
        (design if classify(t) == 'DESIGN' else dispatch).append((f, ln, t))

n = len(design) + len(dispatch)
print(f'HOME lines classified: {n}')
print(f'  DESIGN   (Michael-ruled, world-as-is)      {len(design):>3}  '
      f'-> candidates for a knowledge note')
print(f'  DISPATCH (agent-adjudicated, one arc)      {len(dispatch):>3}  '
      f'-> dies with the plan')
print(f'\n  distinct notes holding >=1 DESIGN line: '
      f'{len({f for f, _, _ in design})}')

print('\n=== DESIGN (read these; they are the migration candidates) ===')
for f, ln, t in design:
    print(f'  [{f[:42]:<42}:{ln:<4}] {t[:90]}')

print('\n=== DISPATCH (sample — verify the split is not eating durable text) ===')
for f, ln, t in dispatch[:14]:
    print(f'  [{f[:42]:<42}:{ln:<4}] {t[:90]}')
print(f'  ... and {max(0, len(dispatch) - 14)} more')
