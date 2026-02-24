use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu ["piano notes", "piano scale", "piano chord"]

# D Major scale reference from Piano Studies
let d_major_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │*│ │ │ │ │  │  │*│ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │"
  "│   │ * │ * │   │ * │ * │ * │   │ * │   │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

let d_major_result = piano notes D E "F#" G A B "C#"
assert equal $d_major_result $d_major_expected "D Major diagram mismatch"

# Bb Major scale reference
let bb_major_expected = [
  "┌──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │ │ │*│  │  │ │ │*│  │  │ │ │ │ │*│  │"
  "│  │ │ │ │ │ │  │  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│   │   │   │   │ * │ * │   │ * │ * │ * │   │"
  "│ F │ G │ A │ B │ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

let bb_major_result = piano notes Bb C D Eb F G A
assert equal $bb_major_result $bb_major_expected "Bb Major diagram mismatch"

# Eb Major scale reference
let eb_major_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │ │*│  │  │ │ │*│ │*│  │  │ │ │*│  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │"
  "│   │   │   │ * │ * │   │   │ * │ * │   │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

let eb_major_result = piano notes Eb F G Ab Bb C D
assert equal $eb_major_result $eb_major_expected "Eb Major diagram mismatch"

# F natural minor scale reference
let f_minor_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │  │  │ │ │*│ │*│  │  │*│ │*│  │   │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │   │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │   │"
  "│   │   │   │ * │ * │   │   │ * │   │   │ * │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │ F │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

let f_minor_result = piano notes F G Ab Bb C Db Eb
assert equal $f_minor_result $f_minor_expected "F minor diagram mismatch"

# Test scale subcommand
let d_major_via_scale = piano scale D Major
assert equal $d_major_via_scale $d_major_expected "D Major via scale subcommand"

# Test chord subcommand
let f_major_chord = piano chord F Major
# F Major triad: F, A, C — just verify it produces valid output
assert ($f_major_chord | str contains "│ * │") "F Major chord should highlight white keys"

print "All integration tests passed!"
