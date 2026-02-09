const paths = [
  /opt/homebrew/bin,  # Homebrew on Apple Silicon (arm64)
  /usr/local/bin,     # Homebrew on Intel Macs (x64)
  ~/bin,
  ~/.cargo/bin,
  ~/.local/bin,
] | path expand

# Normalize PATH to a list (it may be a colon-separated string when inherited from parent shell)
# then prepend our custom paths
$env.PATH = (
  $env.PATH 
  | each { |p| $p | split row ":" } 
  | flatten 
  | prepend $paths 
  | uniq
)

$env.EDITOR = 'code -w'
$env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"
  
# Directories to search for scripts when calling source or use
$env.NU_LIB_DIRS = [($env.HOME | path join 'scripts')]

# Directories to search for plugin binaries when calling register
$env.NU_PLUGIN_DIRS = [($env.HOME | path join 'plugins')]

const 1password_sock = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" | path expand
$env.SSH_AUTH_SOCK = $1password_sock

# Load secrets from 1Password Environment (mounted .env file)
# See: https://developer.1password.com/docs/environments/local-env-file
const secrets_file = "~/.config/secrets.env" | path expand
if ($secrets_file | path exists) {
  open $secrets_file 
    | lines 
    | where { |line| not ($line | str starts-with '#') and ($line | str contains '=') }
    | parse "{key}={value}" 
    | reduce -f {} { |row, acc| $acc | insert $row.key $row.value }
    | load-env
}

const work_env_file = "~/scripts/work-env.nu"
if ($work_env_file | path exists) {
  source-env $work_env_file
}

