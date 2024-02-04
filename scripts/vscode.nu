# A script for helping manage vscode extensions from a bundle file
export def main [] {
  help vscode
}

# Returns the path to the vscodefile
export def "vscode path" [] {
  webdesserts_dot_path
    | path join "vscodefile"
}

# Returns the current list of extensions
export def "vscode list" [--installed] {
  if ($installed) {
    code --list-extensions
    | output
    | lines
    | sort-by value
  } else {
    let $path = (vscode path)
    if ($path | path exists) {
      open $path
      | lines
      | sort-by value
    } else {
      []
    }
  }
}

# Returns a list of installed extensions that aren't in the bundle
export def "vscode diff" [--status: string] {
  let $installed = (vscode list --installed)
  let $bundled = (vscode list)

  let $missing = ($bundled | where (not ($it in $installed)))
  let $new = ($installed | where (not ($it in $bundled)))

  if ($status == "new") {
    $new
  } else if ($status == "missing") {
    $missing
  } else {
    let $missing_table = ($missing | wrap name | insert status "missing")
    let $new_table = ($new | wrap name | insert status "new")


    let diff = ($missing_table | append $new_table)
    
    $diff
  }
}

# Installs all extensions in the vscodefile
export def "vscode bundle install" [] {
  let $path = (vscode path)
  let $extensions = (vscode diff --status="missing")

  $extensions | each { |extension| code --install-extension $extension }
}

# Saves a list of all installed extensions in the vscodefile
export def "vscode bundle" [] {
  let $path = (vscode path)
  let $extensions = (vscode diff --status="new")

  vscode list | append $extensions | save --force $path

  $extensions
}

# Uninstalls any extensions that aren't in the vscodefile
export def "vscode bundle clean" [] {
  let $path = (vscode path)
  let $extensions = (vscode diff --status="new")

  $extensions | each { |extension| code --uninstall-extension $extension }
}

def output [] {
  complete | get stdout | str trim
}

def webdesserts_dot_path [] {
  use utils [exists]

  if (exists dots) {
    dots path webdesserts | output
  } else { 
    error make { msg: "Cannot find dots command" }
  }
}
