use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu *

# scale-intervals
assert equal (scale-intervals "Major") [0, 2, 4, 5, 7, 9, 11]
assert equal (scale-intervals "Minor") [0, 2, 3, 5, 7, 8, 10]

# chord-intervals
assert equal (chord-intervals "Major") [0, 4, 7]
assert equal (chord-intervals "Minor") [0, 3, 7]

# apply-inversion: 1st inversion raises the root an octave
assert equal (apply-inversion [0, 4, 7] 1) [4, 7, 12]

# apply-inversion: 2nd inversion raises root and third an octave
assert equal (apply-inversion [0, 4, 7] 2) [7, 12, 16]

# compute-notes: F Major triad
assert equal (compute-notes "F" [0, 4, 7]) ["F", "A", "C"]

# compute-notes: D Major scale
assert equal (compute-notes "D" [0, 2, 4, 5, 7, 9, 11]) ["D", "E", "F#", "G", "A", "B", "C#"]

print "All music theory tests passed!"
