const paths = [
  ~/.cargo/bin,
  ~/bin,
  /usr/local/bin
]

$env.PATH = ( 
  $env.PATH
  | append $paths
  | path expand
  | str join (char esep)
 )
  
# Directories to search for scripts when calling source or use
$env.NU_LIB_DIRS = [($env.HOME | path join 'scripts')]

# Directories to search for plugin binaries when calling register
$env.NU_PLUGIN_DIRS = [($env.HOME | path join 'plugins')]

const 1password_sock: glob = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
$env.SSH_AUTH_SOCK = $1password_sock

const work_env_config = ~/scripts/work-env.nu
if ($work_env_config | path exists) {
  source $work_env_config
}

