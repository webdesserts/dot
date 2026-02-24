use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu *

# Test range C-E (indices 0-4): C(2) C#(1) D(1) D#(1) E(2)
let widths_ce = (key-widths 0 4)
let highlights_ce = [false, false, false, false, false]

# Top border
assert equal (render-top-border $widths_ce) "┌──┬─┬─┬─┬──┐"

# Top body: no highlights
assert equal (render-top-body $widths_ce $highlights_ce) "│  │ │ │ │  │"

# Top body: C# highlighted
let hl_cs = [false, true, false, false, false]
assert equal (render-top-body $widths_ce $hl_cs) "│  │*│ │ │  │"

# Transition row: shows where black keys end and white keys widen
assert equal (render-transition 0 4) "│  └┬┘ └┬┘  │"

# Bottom body: no highlights, white keys only
let white_hl_ce = [false, false, false]
assert equal (render-bottom-body 0 4 $white_hl_ce) "│   │   │   │"

# Bottom body: D highlighted
let white_hl_d = [false, true, false]
assert equal (render-bottom-body 0 4 $white_hl_d) "│   │ * │   │"

# Bottom labels
assert equal (render-bottom-labels 0 4) "│ C │ D │ E │"

# Bottom border
let white_count_ce = 3
assert equal (render-bottom-border $white_count_ce) "└───┴───┴───┘"

# Verify against D Major first octave segment (C-B, range 0-11)
let widths_cb = (key-widths 0 11)
assert equal (render-top-border $widths_cb) "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
assert equal (render-transition 0 11) "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"

print "All rendering tests passed!"
