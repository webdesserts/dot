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
def note-to-index [note: string] {
  let sharp_match = ($SHARP_NAMES | enumerate | where item == $note)
  if ($sharp_match | is-not-empty) { return ($sharp_match | get index | first) }
  let flat_match = ($FLAT_NAMES | enumerate | where item == $note)
  if ($flat_match | is-not-empty) { return ($flat_match | get index | first) }
  error make {msg: $"Unknown note: \"($note)\". Use C, C#, Db, D, ... B"}
}

# Convert a chromatic index (0-11) to its canonical sharp name
def index-to-name [index: int]: nothing -> string {
  $SHARP_NAMES | get $index
}

# Returns true if the given chromatic index is a black key
def is-black [index: int]: nothing -> bool {
  $index in $BLACK_KEYS
}

# Get the semitone intervals for a named scale
def scale-intervals [name: string] {
  match ($name | str capitalize) {
    "Major" => [0, 2, 4, 5, 7, 9, 11],
    "Minor" => [0, 2, 3, 5, 7, 8, 10],
    _ => (error make {msg: $"Unknown scale: \"($name)\". Supported: Major, Minor"})
  }
}

# Get the semitone intervals and letter steps for a named chord.
# Returns {semitones: list<int>, letters: list<int>} where letters are stacked-third
# positions (0, 2, 4, 6, ...) that resolve the tritone ambiguity in enharmonic spelling.
def chord-intervals [quality: string, extension: string = ""] {
  let key = if $extension == "" {
    $quality | str capitalize
  } else {
    $"($quality | str capitalize) ($extension)"
  }
  let semitones = match $key {
    "Major" => [0, 4, 7],
    "Minor" => [0, 3, 7],
    "Diminished" => [0, 3, 6],
    "Augmented" => [0, 4, 8],
    "Major 7th" => [0, 4, 7, 11],
    "Minor 7th" => [0, 3, 7, 10],
    "Dominant 7th" => [0, 4, 7, 10],
    "Diminished 7th" => [0, 3, 6, 9],
    "Half-diminished 7th" => [0, 3, 6, 10],
    "Major 9th" => [0, 4, 7, 11, 14],
    "Minor 9th" => [0, 3, 7, 10, 14],
    "Dominant 9th" => [0, 4, 7, 10, 14],
    "Major 11th" => [0, 4, 7, 11, 14, 17],
    "Minor 11th" => [0, 3, 7, 10, 14, 17],
    "Dominant 11th" => [0, 4, 7, 10, 14, 17],
    "Major 13th" => [0, 4, 7, 11, 14, 17, 21],
    "Minor 13th" => [0, 3, 7, 10, 14, 17, 21],
    "Dominant 13th" => [0, 4, 7, 10, 14, 17, 21],
    _ => (error make {msg: $"Unknown chord: \"($key)\". Supported: Major, Minor, Diminished, Augmented, and 7th/9th/11th/13th extensions"})
  }
  let letters = 0..<($semitones | length) | each {|i| $i * 2}
  {semitones: $semitones, letters: $letters}
}

# Apply an inversion by rotating the bottom N notes up an octave.
# Works on both plain interval lists and chord records with semitones+letters.
def apply-inversion [intervals, inversion: int] {
  if ($intervals | describe | str starts-with "record") {
    mut semitones = $intervals.semitones
    mut letters = $intervals.letters
    for _ in 0..<$inversion {
      let bottom_s = $semitones | first
      let bottom_l = $letters | first
      $semitones = ($semitones | skip 1 | append ($bottom_s + 12))
      $letters = ($letters | skip 1 | append ($bottom_l + 7))
    }
    {semitones: $semitones, letters: $letters}
  } else {
    mut result = $intervals
    for _ in 0..<$inversion {
      let bottom = $result | first
      $result = ($result | skip 1 | append ($bottom + 12))
    }
    $result
  }
}

# Given a root note and intervals, compute note names using correct enharmonic spelling.
# By default uses the SEMITONE_TO_LETTER_STEP lookup, which works for scales.
# Pass --letter-steps for chords to resolve tritone ambiguity (dim 5th vs aug 4th).
def compute-notes [root: string, intervals: list<int>, --letter-steps: list<int>]: nothing -> list<string> {
  let root_idx = note-to-index $root
  let root_letter = $root | split chars | first
  let letter_start = ($LETTERS | enumerate | where item == $root_letter | get index | first)

  $intervals | enumerate | each {|entry|
    let interval = $entry.item
    let semitones = $interval mod 12
    let abs_idx = ($root_idx + $interval) mod 12

    # Try explicit letter step first (resolves tritone ambiguity for chords),
    # fall back to semitone lookup if it would need a double accidental.
    let primary_step = if $letter_steps != null {
      $letter_steps | get $entry.index
    } else {
      $SEMITONE_TO_LETTER_STEP | get $semitones
    }
    let target_letter = ($LETTERS | get (($letter_start + $primary_step) mod 7))
    let letter_idx = ($LETTER_INDICES | get (($letter_start + $primary_step) mod 7))
    let diff = ($abs_idx - $letter_idx + 12) mod 12

    if $diff in [0, 1, 11] {
      match $diff {
        0 => $target_letter,
        1 => $"($target_letter)#",
        11 => $"($target_letter)b",
      }
    } else {
      # Fall back to semitone-based lookup (avoids double accidentals)
      let fallback_step = $SEMITONE_TO_LETTER_STEP | get $semitones
      let fb_letter = ($LETTERS | get (($letter_start + $fallback_step) mod 7))
      let fb_idx = ($LETTER_INDICES | get (($letter_start + $fallback_step) mod 7))
      let fb_diff = ($abs_idx - $fb_idx + 12) mod 12
      match $fb_diff {
        0 => $fb_letter,
        1 => $"($fb_letter)#",
        11 => $"($fb_letter)b",
        _ => (error make {msg: $"Cannot spell note at interval ($interval) from ($root)"})
      }
    }
  }
}

# Compute the top-row width of each chromatic key in a range.
# start/end are absolute chromatic indices (can exceed 11 for multi-octave).
# Edge white keys gain +1 width when their adjacent black key is cut off by the range boundary.
# Base top-row widths for one octave (C through B).
# White keys next to a natural half-step (B-C, E-F) get 2; others get 1.
const BASE_WIDTHS = [2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 2]

def key-widths [start: int, end: int]: nothing -> list<int> {
  let count = $end - $start + 1
  mut widths = (0..<$count | each {|i| $BASE_WIDTHS | get (($start + $i) mod 12)})

  # Left edge: if the key just before start is black, the first key absorbs its space
  if (is-black (($start - 1 + 12) mod 12)) {
    $widths = ($widths | enumerate | each {|e| if $e.index == 0 { $e.item + 1 } else { $e.item }})
  }

  # Right edge: if the key just after end is black, the last key absorbs its space
  if (is-black (($end + 1) mod 12)) {
    let last = ($count - 1)
    $widths = ($widths | enumerate | each {|e| if $e.index == $last { $e.item + 1 } else { $e.item }})
  }

  $widths
}

# Compute the chromatic start/end range for a set of note names.
# Places notes in ascending order, then extends to the nearest group boundaries
# (CDE / FGAB) on each side.
def auto-range [notes: list<string>]: nothing -> record<start: int, end: int> {
  let root_idx = note-to-index ($notes | first)

  # Place notes in ascending order to find actual span
  mut current = $root_idx
  mut max_note = $root_idx
  for n in $notes {
    let mod_idx = note-to-index $n
    $current = $current + (($mod_idx - ($current mod 12) + 12) mod 12)
    if $current > $max_note { $max_note = $current }
  }
  let min_note = $root_idx
  let max_note_val = $max_note
  let min_mod = $min_note mod 12
  let max_mod = $max_note_val mod 12

  # Left edge: nearest group start (C=0 or F=5) at or before min_note.
  # If min IS a group start, go one further back for padding.
  let group_starts = [0, 5]  # C and F within one octave
  let left = if $min_mod == 0 {
    [($min_note - 7), 0] | math max
  } else if $min_mod == 5 {
    $min_note - 5
  } else {
    $group_starts | each {|gs| $min_note - (($min_mod - $gs + 12) mod 12)} | math max
  }

  # Right edge: if max lands on a group start (C or F), end there.
  # Otherwise extend to nearest group end (E=4 or B=11).
  let right = if $max_mod in $group_starts {
    $max_note_val
  } else {
    let group_ends = [4, 11]  # E and B within one octave
    $group_ends | each {|ge|
      $max_note_val + (($ge - $max_mod + 12) mod 12)
    } | math min
  }

  {start: $left, end: $right}
}

# Get the list of white key absolute indices within a range
def white-keys-in-range [start: int, end: int]: nothing -> list<int> {
  $start..$end | where {|i| not (is-black ($i mod 12))}
}

def render-top-border [widths: list<int>]: nothing -> string {
  let cells = $widths | each {|w| "" | fill -c "─" -w $w}
  $"┌($cells | str join '┬')┐"
}

def render-top-body [widths: list<int>, highlights: list<bool>]: nothing -> string {
  let cells = $widths | enumerate | each {|e|
    if ($highlights | get $e.index) {
      if $e.item == 1 { "●" } else { "●" + ("" | fill -w ($e.item - 1)) }
    } else {
      "" | fill -w $e.item
    }
  }
  $"│($cells | str join '│')│"
}

# Build the transition row where black keys end and white keys widen.
# Each chromatic key contributes its content, and separators depend on the
# black/white boundary between adjacent keys.
def render-transition [start: int, end: int]: nothing -> string {
  let widths = key-widths $start $end
  let count = $end - $start + 1

  mut chars = "│"
  for i in 0..<$count {
    let idx = ($start + $i) mod 12
    let w = $widths | get $i

    # Key content
    if (is-black $idx) {
      $chars = $"($chars)┬"
    } else {
      $chars = $chars + ("" | fill -w $w)
    }

    # Separator to next key (if not the last)
    if $i < ($count - 1) {
      let next_idx = ($start + $i + 1) mod 12
      let cur_black = is-black $idx
      let next_black = is-black $next_idx
      if (not $cur_black) and $next_black {
        $chars = $"($chars)└"
      } else if $cur_black and (not $next_black) {
        $chars = $"($chars)┘"
      } else {
        $chars = $"($chars)│"
      }
    }
  }

  $"($chars)│"
}

def render-bottom-body [start: int, end: int, highlights: list<bool>]: nothing -> string {
  let whites = white-keys-in-range $start $end
  let cells = $whites | enumerate | each {|e|
    if ($highlights | get $e.index) { " ● " } else { "   " }
  }
  $"│($cells | str join '│')│"
}

def render-bottom-labels [start: int, end: int]: nothing -> string {
  let whites = white-keys-in-range $start $end
  let cells = $whites | each {|i|
    let name = index-to-name ($i mod 12)
    $" ($name) "
  }
  $"│($cells | str join '│')│"
}

def render-bottom-border [count: int]: nothing -> string {
  let cells = 0..<$count | each { "───" }
  $"└($cells | str join '┴')┘"
}

# Assemble a complete keyboard diagram for the given highlighted note indices within a range
def render-keyboard [start: int, end: int, highlight_indices: list<int>]: nothing -> string {
  let widths = key-widths $start $end
  let count = $end - $start + 1

  # Top-section highlights: one bool per chromatic key
  let top_highlights = 0..<$count | each {|i|
    let idx = $start + $i
    let mod_idx = $idx mod 12
    (is-black $mod_idx) and ($idx in $highlight_indices)
  }

  # Bottom-section highlights: one bool per white key
  let whites = white-keys-in-range $start $end
  let bottom_highlights = $whites | each {|i| $i in $highlight_indices}

  let white_count = $whites | length

  # Build an empty top body row (no highlights) for spacing
  let empty_top = 0..<$count | each { false }

  [
    (render-top-border $widths)
    (render-top-body $widths $top_highlights)
    (render-top-body $widths $empty_top)
    (render-transition $start $end)
    (render-bottom-body $start $end $bottom_highlights)
    (render-bottom-labels $start $end)
    (render-bottom-border $white_count)
  ] | str join "\n"
}

# Convert note names to ascending absolute indices, each placed at the first
# occurrence at or after the previous note. This correctly wraps notes like
# C# in D Major to the next octave (index 13, not 1).
def notes-to-abs-indices [notes: list<string>, start: int]: nothing -> list<int> {
  mut current = $start
  mut result = []
  for n in $notes {
    let mod_idx = note-to-index $n
    let abs = $current + (($mod_idx - ($current mod 12) + 12) mod 12)
    $result = ($result | append $abs)
    $current = $abs
  }
  $result
}

# Generate a keyboard diagram highlighting the given notes
export def "piano notes" [...notes: string, --range: string, --range-end: string]: nothing -> string {
  if ($notes | is-empty) {
    error make {msg: "No notes provided. Usage: piano notes C E G"}
  }

  let note_list = $notes

  if ($range != null) xor ($range_end != null) {
    error make {msg: "--range and --range-end must be used together"}
  }

  let rng = if $range != null and $range_end != null {
    let s = note-to-index $range
    let e_mod = note-to-index $range_end
    let e = if $e_mod <= $s { $e_mod + 12 } else { $e_mod }
    {start: $s, end: $e}
  } else {
    auto-range $note_list
  }

  let highlight_indices = notes-to-abs-indices $note_list $rng.start
  render-keyboard $rng.start $rng.end $highlight_indices
}

# Generate a keyboard diagram for a named scale
export def "piano scale" [root: string, name: string]: nothing -> string {
  let intervals = scale-intervals $name
  let notes = compute-notes $root $intervals
  # Include the octave of the root to complete the scale
  piano notes ...($notes | append $root)
}

# Generate a keyboard diagram for a named chord, with optional extension and inversion
export def "piano chord" [root: string, quality: string, ...extra_args: string]: nothing -> string {
  mut args = $extra_args
  mut extension = ""

  # Parse optional extension (7th, 9th, 11th, 13th)
  if ($args | is-not-empty) and ($args | first) in ["7th", "9th", "11th", "13th"] {
    $extension = ($args | first)
    $args = ($args | skip 1)
  }

  mut chord = (chord-intervals $quality $extension)

  # Parse optional inversion (e.g. "1st Inversion")
  if ($args | is-not-empty) {
    let inv_str = $args | first
    let inv_num = match $inv_str {
      "1st" => 1,
      "2nd" => 2,
      "3rd" => 3,
      _ => (error make {msg: $"Unknown argument: \"($inv_str)\". Expected an extension or inversion"})
    }
    $args = ($args | skip 1)
    # Consume optional "Inversion" word
    if ($args | is-not-empty) and ($args | first) == "Inversion" {
      $args = ($args | skip 1)
    }
    $chord = (apply-inversion $chord $inv_num)
  }

  if ($args | is-not-empty) {
    error make {msg: $"Unexpected arguments: ($args | str join ' ')"}
  }

  let notes = compute-notes $root $chord.semitones --letter-steps $chord.letters
  piano notes ...$notes
}
