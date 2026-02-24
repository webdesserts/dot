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
# Base top-row widths for one octave (C through B).
# White keys next to a natural half-step (B-C, E-F) get 2; others get 1.
const BASE_WIDTHS = [2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 2]

export def key-widths [start: int, end: int]: nothing -> list<int> {
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
# Extends left to the nearest group boundary (C or F) and right to cover the octave.
export def auto-range [notes: list<string>]: nothing -> record<start: int, end: int> {
  let root_idx = note-to-index ($notes | first)
  let octave = $root_idx + 12
  let root_mod = $root_idx mod 12

  # Left edge: nearest group start (C=0 or F=5) strictly before root.
  # If root IS a group start, go one further back.
  let group_starts = [0, 5]  # C and F within one octave
  let left = if $root_mod == 0 {
    # Root is C — go back to F in previous octave, but floor at 0
    [($root_idx - 7), 0] | math max
  } else if $root_mod == 5 {
    # Root is F — go back to C in same octave
    $root_idx - 5
  } else {
    # Find nearest C or F below root
    $group_starts | each {|gs| $root_idx - (($root_mod - $gs + 12) mod 12)} | math max
  }

  # Right edge: if octave lands on a group start (C or F), end there.
  # Otherwise extend to nearest group end (E=4 or B=11).
  let octave_mod = $octave mod 12
  let right = if $octave_mod in $group_starts {
    $octave
  } else {
    let group_ends = [4, 11]  # E and B within one octave
    $group_ends | each {|ge|
      let candidate = $octave + (($ge - $octave_mod + 12) mod 12)
      $candidate
    } | math min
  }

  {start: $left, end: $right}
}

# Get the list of white key absolute indices within a range
export def white-keys-in-range [start: int, end: int]: nothing -> list<int> {
  $start..$end | where {|i| not (is-black ($i mod 12))}
}

export def render-top-border [widths: list<int>]: nothing -> string {
  let cells = $widths | each {|w| "" | fill -c "─" -w $w}
  $"┌($cells | str join '┬')┐"
}

export def render-top-body [widths: list<int>, highlights: list<bool>]: nothing -> string {
  let cells = $widths | enumerate | each {|e|
    if ($highlights | get $e.index) {
      if $e.item == 1 { "*" } else { "*" + ("" | fill -w ($e.item - 1)) }
    } else {
      "" | fill -w $e.item
    }
  }
  $"│($cells | str join '│')│"
}

# Build the transition row where black keys end and white keys widen.
# Each chromatic key contributes its content, and separators depend on the
# black/white boundary between adjacent keys.
export def render-transition [start: int, end: int]: nothing -> string {
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

export def render-bottom-body [start: int, end: int, highlights: list<bool>]: nothing -> string {
  let whites = white-keys-in-range $start $end
  let cells = $whites | enumerate | each {|e|
    if ($highlights | get $e.index) { " * " } else { "   " }
  }
  $"│($cells | str join '│')│"
}

export def render-bottom-labels [start: int, end: int]: nothing -> string {
  let whites = white-keys-in-range $start $end
  let cells = $whites | each {|i|
    let name = index-to-name ($i mod 12)
    $" ($name) "
  }
  $"│($cells | str join '│')│"
}

export def render-bottom-border [count: int]: nothing -> string {
  let cells = 0..<$count | each { "───" }
  $"└($cells | str join '┴')┘"
}

# Assemble a complete keyboard diagram for the given highlighted note indices within a range
export def render-keyboard [start: int, end: int, highlight_indices: list<int>]: nothing -> string {
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
  let note_list = $notes

  let rng = if $range != null and $range_end != null {
    let s = note-to-index $range
    let e_mod = note-to-index $range_end
    let e = if $e_mod <= $s { $e_mod + 12 } else { $e_mod }
    {start: $s, end: $e}
  } else {
    auto-range $note_list
  }

  mut highlight_indices = (notes-to-abs-indices $note_list $rng.start)

  # Add the root's octave repeat if it falls within the range
  let root_octave = ($highlight_indices | first) + 12
  if $root_octave <= $rng.end {
    $highlight_indices = ($highlight_indices | append $root_octave)
  }

  render-keyboard $rng.start $rng.end $highlight_indices
}

# Generate a keyboard diagram for a named scale
export def "piano scale" [root: string, name: string]: nothing -> string {
  let intervals = scale-intervals $name
  let notes = compute-notes $root $intervals
  piano notes ...$notes
}

# Generate a keyboard diagram for a named chord, with optional inversion
export def "piano chord" [root: string, name: string, ...inversion_args: string]: nothing -> string {
  mut intervals = chord-intervals $name

  # Parse optional "1st Inversion" or "2nd Inversion" from extra args
  if ($inversion_args | length) >= 2 {
    let inv_str = $inversion_args | first
    let inv_num = match $inv_str {
      "1st" => 1,
      "2nd" => 2,
      "3rd" => 3,
    }
    $intervals = (apply-inversion $intervals $inv_num)
  }

  let notes = compute-notes $root $intervals
  piano notes ...$notes
}
