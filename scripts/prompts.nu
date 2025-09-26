export def --env "set minimal" [] {
  const PINK = '#ee5485'
  const PURPLE = '#7562ec'

  def paint [color: string] : string -> string {
    $"(ansi { fg: $color, attr: b })($in)(ansi reset)"
  }

  def create_left_prompt [] {
      let path = ($env.PWD)
      let home = ($env.HOME)
      let line2 = ($path | str replace $home '~')

      $"($line2)"
  }

  def create_right_prompt [] {
      let user = ($env.USER)
      let host = (hostname | complete | get stdout | str trim)

      echo $"($user)@($host)" | paint $PINK
      # let time_segment = ([
      #     (date now | format date '%m/%d/%Y %r')
      # ] | str join)

      # echo $time_segment | paint $PURPLE
  }
  
  # Use nushell functions to define your right and left prompt
  $env.PROMPT_COMMAND = { print ""; create_left_prompt }
  $env.PROMPT_COMMAND_RIGHT = { create_right_prompt }

  # The prompt indicators are environmental variables that represent
  # the state of the prompt
  $env.PROMPT_INDICATOR = " » "
  $env.PROMPT_INDICATOR_VI_INSERT = " » "
  $env.PROMPT_INDICATOR_VI_NORMAL = " : "
  $env.PROMPT_MULTILINE_INDICATOR  = " ::: "
}