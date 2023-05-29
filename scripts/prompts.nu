export def-env "set minimal" [] {
  def create_left_prompt [] {
      let path = ($env.PWD)
      let user = ($env.USER)
      let host = (hostname | complete | get stdout | str trim)

      let line1 = ($"($user)@($host)" | ansi gradient --fgstart 0xEE5485 --fgend 0x7562EC)
      let line2 = $path

      $"($line1)\n($line2)"
  }

  def create_right_prompt [] {
      let time_segment = ([
          (date now | date format '%m/%d/%Y %r')
      ] | str join)

      echo $time_segment | ansi gradient --fgend 0xEE5485 --fgstart 0x7562EC
  }

  # Use nushell functions to define your right and left prompt
  let-env PROMPT_COMMAND = { print ""; create_left_prompt }
  let-env PROMPT_COMMAND_RIGHT = { create_right_prompt }

  # The prompt indicators are environmental variables that represent
  # the state of the prompt
  let-env PROMPT_INDICATOR = "» "
  let-env PROMPT_INDICATOR_VI_INSERT = "» "
  let-env PROMPT_INDICATOR_VI_NORMAL = ": "
  let-env PROMPT_MULTILINE_INDICATOR  = "::: "
}