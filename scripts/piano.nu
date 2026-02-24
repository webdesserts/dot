# Piano keyboard diagram generator for Obsidian music notes

# Convert a note name (e.g. "C", "C#", "Bb") to a chromatic index (0-11)
export def note-to-index [note: string]: nothing -> int {
  -1
}

# Convert a chromatic index (0-11) to its canonical sharp name
export def index-to-name [index: int]: nothing -> string {
  "X"
}

# Returns true if the given chromatic index is a black key
export def is-black [index: int]: nothing -> bool {
  false
}
