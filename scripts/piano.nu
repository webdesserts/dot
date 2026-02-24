# Piano keyboard diagram generator for Obsidian music notes

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
const BLACK_KEYS = [1, 3, 6, 8, 10]
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"]
const LETTER_INDICES = [0, 2, 4, 5, 7, 9, 11]

# Maps a semitone interval to the number of letter steps in the musical alphabet.
# e.g. major 3rd (4 semitones) = 2 letter steps, perfect 5th (7) = 4 letter steps.
const SEMITONE_TO_LETTER_STEP = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6]

# Convert a note name (e.g. "C", "C#", "Bb") to a chromatic index (0-11)
export def note-to-index [note: string]: nothing -> int {
  let sharp_match = ($SHARP_NAMES | enumerate | where item == $note)
  if ($sharp_match | is-not-empty) { return ($sharp_match | get index | first) }
  $FLAT_NAMES | enumerate | where item == $note | get index | first
}

# Convert a chromatic index (0-11) to its canonical sharp name
export def index-to-name [index: int]: nothing -> string {
  $SHARP_NAMES | get $index
}

# Returns true if the given chromatic index is a black key
export def is-black [index: int]: nothing -> bool {
  $index in $BLACK_KEYS
}

# Get the semitone intervals for a named scale
export def scale-intervals [name: string]: nothing -> list<int> {
  match $name {
    "Major" => [0, 2, 4, 5, 7, 9, 11],
    "Minor" => [0, 2, 3, 5, 7, 8, 10],
  }
}

# Get the semitone intervals for a named chord
export def chord-intervals [name: string]: nothing -> list<int> {
  match $name {
    "Major" => [0, 4, 7],
    "Minor" => [0, 3, 7],
  }
}

# Apply an inversion by rotating the bottom N notes up an octave
export def apply-inversion [intervals: list<int>, inversion: int]: nothing -> list<int> {
  mut result = $intervals
  for _ in 0..<$inversion {
    let bottom = $result | first
    $result = ($result | skip 1 | append ($bottom + 12))
  }
  $result
}

# Given a root note and intervals, compute note names using correct enharmonic spelling.
# Uses the standard semitone-to-letter-step mapping so chords and scales both spell correctly.
export def compute-notes [root: string, intervals: list<int>]: nothing -> list<string> {
  let root_idx = note-to-index $root
  let root_letter = $root | split chars | first
  let letter_start = ($LETTERS | enumerate | where item == $root_letter | get index | first)

  $intervals | each {|interval|
    let semitones = $interval mod 12
    let letter_step = $SEMITONE_TO_LETTER_STEP | get $semitones
    let abs_idx = ($root_idx + $interval) mod 12
    let target_letter = ($LETTERS | get (($letter_start + $letter_step) mod 7))
    let letter_idx = ($LETTER_INDICES | get (($letter_start + $letter_step) mod 7))
    let diff = ($abs_idx - $letter_idx + 12) mod 12
    match $diff {
      0 => $target_letter,
      1 => $"($target_letter)#",
      11 => $"($target_letter)b",
    }
  }
}

# Compute the top-row width of each chromatic key in a range.
# start/end are absolute chromatic indices (can exceed 11 for multi-octave).
# Edge white keys gain +1 width when their adjacent black key is cut off by the range boundary.
export def key-widths [start: int, end: int]: nothing -> list<int> {
  []
}
