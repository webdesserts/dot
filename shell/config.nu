# Nushell Config File
# Last updated against: 0.72.0

use ~/scripts/utils.nu *
use ~/scripts/externs.nu *
use ~/scripts/themes.nu
use ~/scripts/vscode.nu *
use ~/scripts/prompts.nu

# change project
alias jp = cd $"(projects list | fzf | str trim)"

let theme = (themes desserts)
prompts set minimal

# The default config record. This is where much of your global configuration is setup.
let-env config = {
  color_config: $theme
  use_grid_icons: true
  footer_mode: "25" # always, never, number_of_rows, auto
  float_precision: 2
  use_ansi_coloring: true
  edit_mode: vi # emacs, vi
  show_banner: false
  completions: {
    quick: true  # set this to false to prevent auto-selecting completions when only one remains
    partial: true  # set this to false to prevent partial filling of the prompt
  }
  table: {
    mode: rounded # basic, compact, compact_double, light, thin, with_love, rounded, reinforced, heavy, none, other
  }
  ls: {
    use_ls_colors: false
  }
  rm: {
    always_trash: false
  }
  filesize: {
    metric: true
    format: "auto" # b, kb, kib, mb, mib, gb, gib, tb, tib, pb, pib, eb, eib, zb, zib, auto
  }
  history: {
    max_size: 10000
  }
  keybindings: [
    {
      name: completion_menu
      modifier: none
      keycode: tab
      mode: emacs # Options: emacs vi_normal vi_insert
      event: {
        until: [
          { send: menu name: completion_menu }
          { send: menunext }
        ]
      }
    }
    {
      name: completion_previous
      modifier: shift
      keycode: backtab
      mode: [emacs, vi_normal, vi_insert] # Note: You can add the same keybinding to all modes by using a list
      event: { send: menuprevious }
    }
    {
      name: history_menu
      modifier: control
      keycode: char_x
      mode: emacs
      event: {
        until: [
          { send: menu name: history_menu }
          { send: menupagenext }
        ]
      }
    }
    {
      name: history_previous
      modifier: control
      keycode: char_z
      mode: emacs
      event: {
        until: [
          { send: menupageprevious }
          { edit: undo }
        ]
      }
    }
  ]
}
