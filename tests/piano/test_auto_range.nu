use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu *

# Single note: C# → just the CDE group
assert equal (auto-range ["C#"]) {start: 0, end: 4}

# D Major scale (7 notes, no octave): span D(2)→C#(13), extends to C(0)→E(16)
assert equal (auto-range ["D", "E", "F#", "G", "A", "B", "C#"]) {start: 0, end: 16}

# D Major scale with octave (8 notes): span D(2)→D(14), same range C(0)→E(16)
assert equal (auto-range ["D", "E", "F#", "G", "A", "B", "C#", "D"]) {start: 0, end: 16}

# Bb Major with octave: span Bb(10)→Bb(22), left→F(5), right→B(23)
assert equal (auto-range ["Bb", "C", "D", "Eb", "F", "G", "A", "Bb"]) {start: 5, end: 23}

# F minor with octave: span F(5)→F(17), left→C(0), F(17) IS group start→end at F(17)
assert equal (auto-range ["F", "G", "Ab", "Bb", "C", "Db", "Eb", "F"]) {start: 0, end: 17}

# Eb Major with octave: span Eb(3)→Eb(15), left→C(0), right→E(16)
assert equal (auto-range ["Eb", "F", "G", "Ab", "Bb", "C", "D", "Eb"]) {start: 0, end: 16}

# C Major with octave: span C(0)→C(12), left→C(0) (floor), C(12) IS group start→end at C(12)
assert equal (auto-range ["C", "D", "E", "F", "G", "A", "B", "C"]) {start: 0, end: 12}

# F Major chord: span F(5)→C(12), left→C(0), C(12) IS group start→end at C(12)
assert equal (auto-range ["F", "A", "C"]) {start: 0, end: 12}

print "All auto-range tests passed!"
