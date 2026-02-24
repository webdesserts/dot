use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu ["piano notes", "piano scale", "piano chord"]

# D Major scale reference from Piano Studies (via piano scale, includes octave repeat)
let d_major_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │●│ │ │ │ │  │  │●│ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │"
  "│   │ ● │ ● │   │ ● │ ● │ ● │   │ ● │   │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano scale D Major) $d_major_expected "D Major scale"

# Bb Major scale reference
let bb_major_expected = [
  "┌──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │ │ │●│  │  │ │ │●│  │  │ │ │ │ │●│  │"
  "│  │ │ │ │ │ │  │  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│   │   │   │   │ ● │ ● │   │ ● │ ● │ ● │   │"
  "│ F │ G │ A │ B │ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano scale Bb Major) $bb_major_expected "Bb Major scale"

# Eb Major scale reference (corrected bottom body from Piano Studies)
let eb_major_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │ │●│  │  │ │ │●│ │●│  │  │ │ │●│  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │"
  "│   │   │   │ ● │ ● │   │   │ ● │ ● │   │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano scale Eb Major) $eb_major_expected "Eb Major scale"

# F natural minor scale reference
let f_minor_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │  │  │ │ │●│ │●│  │  │●│ │●│  │   │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │   │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │   │"
  "│   │   │   │ ● │ ● │   │   │ ● │   │   │ ● │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │ F │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano scale F Minor) $f_minor_expected "F minor scale"

# Single note: minimal range
let c_sharp_expected = [
  "┌──┬─┬─┬─┬──┐"
  "│  │●│ │ │  │"
  "│  │ │ │ │  │"
  "│  └┬┘ └┬┘  │"
  "│   │   │   │"
  "│ C │ D │ E │"
  "└───┴───┴───┘"
] | str join "\n"

assert equal (piano notes "C#") $c_sharp_expected "Single note C#"

# Chord subcommand
let f_major_chord = piano chord F Major
assert ($f_major_chord | str contains "│ ● │") "F Major chord should highlight white keys"

print "All integration tests passed!"
