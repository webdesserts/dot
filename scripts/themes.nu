# for more information on themes see
# https://www.nushell.sh/book/coloring_and_theming.html

export def desserts [] {
  # As of 0.61.0 it looks like I'm not able to the default keyword directly and instead need to use
  # object notation instead
  #
  # @see https://github.com/nushell/nushell/issues/5173
  let $default = { fg: 'default' }
  let $default_dimmed = { fg: 'default', attr: d }
  let $default_bold = { fg: 'default', attr: b }
  let $default_bold_dimmed = { fg: 'default', attr: bd }

  {
      # color for nushell primitives
      any: $default
      separator: white
      leading_trailing_space_bg: { attr: b }
      header: $default_bold_dimmed
      row_index: $default_bold_dimmed
      empty: $default
      filesize: $default
      duration: $default
      date: $default
      bool: $default_bold
      int: blue_bold
      range: $default_bold
      float: blue_bold
      string: $default
      nothing: $default
      binary: $default
      cellpath: $default
      record: $default_bold
      list: $default_bold
      block: $default_bold
      hints: $default_dimmed

      # shapes are used to change the cli syntax highlighting
      shape_garbage: { fg: "#B4204E", attr: bui }
      shape_binary: $default
      shape_bool: $default_bold
      shape_int: green_bold
      shape_float: green_bold
      shape_range: $default
      shape_internalcall: { fg: default, attr: bi }
      shape_external: $default_bold
      shape_literal: $default
      shape_operator: $default
      shape_signature: $default
      shape_string: green
      shape_string_interpolation: green_bold
      shape_datetime: $default
      shape_list: $default
      shape_table: $default
      shape_record: $default
      shape_block: $default
      shape_filepath: $default
      shape_globpattern: $default
      shape_variable: purple_bold
      shape_flag: $default
      shape_custom: $default
      shape_nothing: $default
  }
} 