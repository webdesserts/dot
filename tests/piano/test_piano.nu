use std/assert
use /Users/michael/.dots/webdesserts/scripts/piano.nu ["piano notes", "piano scale", "piano chord"]

# --- Scales ---

let c_major_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │  │  │ │ │ │ │ │  │   │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │   │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │   │"
  "│ ● │ ● │ ● │ ● │ ● │ ● │ ● │ ● │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │"
  "└───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano scale C Major) $c_major_expected "C Major scale"

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

let f_minor_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │  │  │ │ │●│ │●│  │  │●│ │●│  │   │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │   │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │   │"
  "│   │   │   │ ● │ ● │   │   │ ● │   │   │ ● │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │ F │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano scale F Minor) $f_minor_expected "F Minor scale"

# --- Single notes ---

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

let gb_expected = [
  "┌──┬─┬─┬─┬─┬─┬──┐"
  "│  │●│ │ │ │ │  │"
  "│  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘ └┬┘  │"
  "│   │   │   │   │"
  "│ F │ G │ A │ B │"
  "└───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano notes Gb) $gb_expected "Single note Gb"

# --- Chords ---

let f_major_chord_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │  │  │ │ │ │ │ │  │   │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │   │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │   │"
  "│   │   │   │ ● │   │ ● │   │ ● │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │"
  "└───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord F Major) $f_major_chord_expected "F Major chord"

let c_major_1st_inv_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │  │  │ │ │ │ │ │  │   │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │   │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │   │"
  "│   │   │ ● │   │ ● │   │   │ ● │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │"
  "└───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Major 1st Inversion) $c_major_1st_inv_expected "C Major 1st Inversion"

let c_major_2nd_inv_expected = [
  "┌──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │"
  "│   │ ● │   │   │ ● │   │ ● │"
  "│ F │ G │ A │ B │ C │ D │ E │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Major 2nd Inversion) $c_major_2nd_inv_expected "C Major 2nd Inversion"

let bb_minor_expected = [
  "┌──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬───┐"
  "│  │ │ │ │ │●│  │  │●│ │ │  │   │"
  "│  │ │ │ │ │ │  │  │ │ │ │  │   │"
  "│  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │   │"
  "│   │   │   │   │   │   │   │ ● │"
  "│ F │ G │ A │ B │ C │ D │ E │ F │"
  "└───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord Bb Minor) $bb_minor_expected "Bb Minor chord"

let c_dim_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │●│  │  │●│ │ │ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│ ● │   │   │   │   │   │   │"
  "│ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Diminished) $c_dim_expected "C Diminished chord"

let c_aug_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │ │ │●│ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│ ● │   │ ● │   │   │   │   │"
  "│ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Augmented) $c_aug_expected "C Augmented chord"

let cs_dim_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │●│ │ │  │  │ │ │ │ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│   │   │ ● │   │ ● │   │   │"
  "│ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord "C#" Diminished) $cs_dim_expected "C# Diminished chord"

# --- Extended chords (7th, 9th, 13th) ---

let c_major_7th_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│ ● │   │ ● │   │ ● │   │ ● │"
  "│ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Major 7th) $c_major_7th_expected "C Major 7th chord"

let c_minor_7th_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │●│  │  │ │ │ │ │●│  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│ ● │   │   │   │ ● │   │   │"
  "│ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Minor 7th) $c_minor_7th_expected "C Minor 7th chord"

let c_dom_7th_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │ │ │ │ │●│  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│ ● │   │ ● │   │ ● │   │   │"
  "│ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Dominant 7th) $c_dom_7th_expected "C Dominant 7th chord"

let c_dom_9th_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │ │ │ │ │●│  │  │ │ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │"
  "│ ● │   │ ● │   │ ● │   │   │   │ ● │   │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Dominant 9th) $c_dom_9th_expected "C Dominant 9th chord"

let c_dom_13th_expected = [
  "┌──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┬──┬─┬─┬─┬──┬──┬─┬─┬─┬─┬─┬──┐"
  "│  │ │ │ │  │  │ │ │ │ │●│  │  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  │ │ │ │  │  │ │ │ │ │ │  │  │ │ │ │  │  │ │ │ │ │ │  │"
  "│  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │  └┬┘ └┬┘  │  └┬┘ └┬┘ └┬┘  │"
  "│ ● │   │ ● │   │ ● │   │   │   │ ● │   │ ● │   │ ● │   │"
  "│ C │ D │ E │ F │ G │ A │ B │ C │ D │ E │ F │ G │ A │ B │"
  "└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano chord C Dominant 13th) $c_dom_13th_expected "C Dominant 13th chord"

# --- Explicit range flags ---

let d_g_range_expected = [
  "┌──┬─┬──┬──┬─┬─┬─┬──┐"
  "│  │ │  │  │ │ │ │  │"
  "│  │ │  │  │ │ │ │  │"
  "│  └┬┘  │  └┬┘ └┬┘  │"
  "│ ● │   │   │ ● │   │"
  "│ D │ E │ F │ G │ A │"
  "└───┴───┴───┴───┴───┘"
] | str join "\n"

assert equal (piano notes D G --range D --range-end A) $d_g_range_expected "D and G with explicit D-A range"

# --- Error cases ---

try { piano notes } catch {|e| assert ($e.msg | str contains "No notes provided") "expected No notes provided error" }
try { piano notes H } catch {|e| assert ($e.msg | str contains "Unknown note") "expected Unknown note error" }
try { piano scale C Blues } catch {|e| assert ($e.msg | str contains "Unknown scale") "expected Unknown scale error" }
try { piano chord C Thirteenth } catch {|e| assert ($e.msg | str contains "Unknown chord") "expected Unknown chord error" }
try { piano chord C Major 4th Inversion } catch {|e| assert ($e.msg | str contains "Unknown argument") "expected Unknown argument error" }
try { piano notes C --range C } catch {|e| assert ($e.msg | str contains "must be used together") "expected must be used together error" }

print "All piano tests passed!"
