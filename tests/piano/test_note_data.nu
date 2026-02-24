use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu *

# note-to-index: natural notes
assert equal (note-to-index "C") 0
assert equal (note-to-index "D") 2
assert equal (note-to-index "E") 4
assert equal (note-to-index "F") 5
assert equal (note-to-index "G") 7
assert equal (note-to-index "A") 9
assert equal (note-to-index "B") 11

# note-to-index: sharps
assert equal (note-to-index "C#") 1
assert equal (note-to-index "F#") 6

# note-to-index: flats
assert equal (note-to-index "Db") 1
assert equal (note-to-index "Eb") 3
assert equal (note-to-index "Bb") 10

# index-to-name: canonical sharp names
assert equal (index-to-name 0) "C"
assert equal (index-to-name 1) "C#"
assert equal (index-to-name 6) "F#"
assert equal (index-to-name 11) "B"

# is-black: black keys
assert equal (is-black 1) true
assert equal (is-black 3) true
assert equal (is-black 6) true
assert equal (is-black 8) true
assert equal (is-black 10) true

# is-black: white keys
assert equal (is-black 0) false
assert equal (is-black 2) false
assert equal (is-black 4) false
assert equal (is-black 5) false
assert equal (is-black 7) false
assert equal (is-black 9) false
assert equal (is-black 11) false

print "All note data tests passed!"
