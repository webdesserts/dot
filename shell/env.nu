# Specifies how environment variables are:
# - converted from a string to a value on Nushell startup (from_string)
# - converted from a value back to a string when running external commands (to_string)
# Note: The conversions happen *after* config.nu is loaded
let-env ENV_CONVERSIONS = {
  "PATH": {
    from_string: { |s| $s | split row (char esep) | path expand --no-symlink }
    to_string: { |v| $v | path expand --no-symlink | str join (char esep) }
  }
  "Path": {
    from_string: { |s| $s | split row (char esep) | path expand --no-symlink }
    to_string: { |v| $v | path expand --no-symlink | str join (char esep) }
  }
}


let paths = [
  ~/.cargo/bin,
  ~/bin,
  /usr/local/bin
]

let-env PATH = ( 
  $env.PATH
  | append $paths
  | path expand
  | str join (char esep)
 )
  
# Directories to search for scripts when calling source or use
let-env NU_LIB_DIRS = [($env.HOME | path join 'scripts')]

# Directories to search for plugin binaries when calling register
let-env NU_PLUGIN_DIRS = [($env.HOME | path join 'plugins')]

# @todo conditionally include this script
source ~/scripts/work-env.nu;
