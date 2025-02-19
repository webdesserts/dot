# A script for helping manage vscode extensions from a bundle file

# Returns the path to the vscodefile
export def "vscode path" []: nothing -> path {
  webdesserts_dot_path
    | path join "vscodefile"
}

# Returns a list of extensions currenty installed in vscode
export def "vscode list" []: nothing -> table<name: string, bundle: bool> {
  let $installed = (get_installed_extensions)
  let $bundled = (get_bundled_extensions)

  $installed | wrap name | insert bundled { |ext| $ext.name in $bundled }
}

# Returns a list of extensions currently saved in the bundled vscodefile
export def "vscode bundle list" []: nothing -> table<name: string, installed: bool> {
  let $bundled = (get_bundled_extensions)
  let $installed = (get_installed_extensions)

  $bundled | wrap name | insert installed { |ext| $ext.name in $installed }
}

# Uninstalls any extensions that aren't in the vscodefile
# Returns the list of unintalled extensions
export def "vscode clean" [] : nothing -> list<any> {
  let $path = vscode path
  let $extras = vscode bundle list | where not installed | get name

  $extras | each { |extension| code --uninstall-extension $extension }
  $extras
}


# Returns a list of extensions that are installed in vscode but aren't in the bundle
# - status: "uninstalled" if the extension is in the bundle but not installed
# - status: "unbundled" if the extension is installed but not in the bundle
export def "vscode status" []: nothing -> table<name: string, status: string> {
  let $installed = vscode list

  let $missing = vscode bundle list | where not installed | select name | insert status "uninstalled"
  let $new = vscode list | where not bundled | select name | insert status "unbundled"

  let diff = $missing | append $new
  
  $diff
}

# Saves a list of all installed extensions in the vscodefile
export def "vscode bundle save" [] : nothing -> list<string> {
  let $path = vscode path
  let $new_extensions = vscode list | where not bundled | get name
  let $bundled = vscode bundle list | get name

  $bundled | append $new_extensions | sort --natural | save --force $path

  $new_extensions | get name
}

# Installs all extensions in the vscodefile
export def "vscode bundle install" [] : nothing -> list<string> {
  let $path = vscode path
  let $missing_extensions = vscode bundle list | where not installed | get name

  $missing_extensions | each { |extension| code --install-extension $extension }
  $missing_extensions
}

# Removes any extensions that are in the bundle but not installed.
# Returns the list of extensions that were removed
export def "vscode bundle clean" [] : nothing -> list<string> {
  let $path = (vscode path)
  let $installed_extensions = vscode bundle list | where installed | get name

  $installed_extensions | save --force $path
  $installed_extensions
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

def get_installed_extensions [] : nothing -> list<string> {
  code --list-extensions
  | output
  | lines
  | sort --values --natural
}

def get_bundled_extensions [] : nothing -> list<string> {
  let $path = (vscode path)
  if ($path | path exists) {
    open $path
    | lines
    | sort --values --natural
  } else {
    []
  }
}
