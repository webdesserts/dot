const paths = [
  /usr/local/bin,
  ~/bin,
  ~/.cargo/bin,
  ~/.local/bin,
] | path expand

$env.PATH = ( 
  $env.PATH | prepend $paths
 )

$env.EDITOR = 'code -w'
  
# Directories to search for scripts when calling source or use
$env.NU_LIB_DIRS = [($env.HOME | path join 'scripts')]

# Directories to search for plugin binaries when calling register
$env.NU_PLUGIN_DIRS = [($env.HOME | path join 'plugins')]

const 1password_sock = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" | path expand
$env.SSH_AUTH_SOCK = $1password_sock

const work_env_file = "~/scripts/work-env.nu"
if ($work_env_file | path exists) {
  source-env $work_env_file
}

