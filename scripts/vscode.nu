
# A script for helping manage vscode extensions from a bundle file
export def main [] {
  help vscode
}

# Returns the path to the vscodefile
export def "vscode path" []: nothing -> string {
  webdesserts_dot_path
    | path join "vscodefile"
}

# Returns the current list of extensions
export def "vscode list" [--installed]: nothing -> list<string> {
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
export def "vscode diff" [--status: string]: nothing -> table<name: string, status: string> {
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
export def "vscode bundle install" [] : nothing -> nothing {
  let $path = (vscode path)
  let $extensions = (vscode diff --status="missing")

  $extensions | each { |extension| code --install-extension $extension }
}

# Saves a list of all installed extensions in the vscodefile
export def "vscode bundle" [] : nothing -> table<name: string, status: string> {
  let $path = (vscode path)
  let $extensions = (vscode diff --status="new")

  vscode list | append $extensions | save --force $path

  $extensions
}

# Uninstalls any extensions that aren't in the vscodefile
export def "vscode bundle clean" [] : nothing -> nothing {
  let $path = (vscode path)
  let $extensions = (vscode diff --status="new")

  $extensions | each { |extension| code --uninstall-extension $extension }
}

def output [] : any -> string {
  complete | get stdout | str trim
}

def webdesserts_dot_path [] : nothing -> string {
  use utils.nu [exists]

  if (exists dots) {
    dots path webdesserts | output
  } else { 
    error make { msg: "Cannot find dots command" }
  }
}
