use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu *

# D Major: root D in CDE group, left→C(0), octave D(14) not group start→extend to E(16)
assert equal (auto-range ["D", "E", "F#", "G", "A", "B", "C#"]) {start: 0, end: 16}

# Bb Major: root Bb in FGAB group, left→F(5), octave Bb(22) not group start→extend to B(23)
assert equal (auto-range ["Bb", "C", "D", "Eb", "F", "G", "A"]) {start: 5, end: 23}

# F minor: root F IS group start→left goes back to C(0), octave F(17) IS group start→end at F(17)
assert equal (auto-range ["F", "G", "Ab", "Bb", "C", "Db", "Eb"]) {start: 0, end: 17}

# Eb Major: root Eb in CDE group, left→C(0), octave Eb(15) not group start→extend to E(16)
assert equal (auto-range ["Eb", "F", "G", "Ab", "Bb", "C", "D"]) {start: 0, end: 16}

# C Major: root C IS group start but C(0) is minimum→stay at C(0), octave C(12) IS group start→end at C(12)
assert equal (auto-range ["C", "D", "E", "F", "G", "A", "B"]) {start: 0, end: 12}

# F Major: root F IS group start→left to C(0), octave F(17) IS group start→end at F(17)
assert equal (auto-range ["F", "G", "A", "Bb", "C", "D", "E"]) {start: 0, end: 17}

print "All auto-range tests passed!"
