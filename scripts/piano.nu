# Piano keyboard diagram generator for Obsidian music notes

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
const BLACK_KEYS = [1, 3, 6, 8, 10]

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
  []
}

# Get the semitone intervals for a named chord
export def chord-intervals [name: string]: nothing -> list<int> {
  []
}

# Apply an inversion to a list of intervals by rotating the bottom N notes up an octave
export def apply-inversion [intervals: list<int>, inversion: int]: nothing -> list<int> {
  []
}

# Given a root note name and intervals, compute the list of note names
export def compute-notes [root: string, intervals: list<int>]: nothing -> list<string> {
  []
}
