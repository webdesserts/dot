use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu *

# Full octave C-B: standard widths, no edge adjustments needed
assert equal (key-widths 0 11) [2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 2]

# Partial range C-E: left edge C is clean, right edge E is clean (no black key to its right)
assert equal (key-widths 0 4) [2, 1, 1, 1, 2]

# Range D-A: D gets +1 left (C# cut off), A gets +1 right (Bb cut off)
assert equal (key-widths 2 9) [2, 1, 1, 1, 2, 2, 1, 1]

# Range F-B: F is clean on left (no black key between E and F), B is clean on right
assert equal (key-widths 5 11) [2, 1, 1, 1, 1, 1, 2]

# Range F-E (almost 2 octaves minus F): used in Bb Major reference
assert equal (key-widths 5 16) [2, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 2]

print "All key geometry tests passed!"
