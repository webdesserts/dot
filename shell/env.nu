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

# --- SSH Agent ---
# Use the system ssh-agent instead of 1Password's desktop agent socket.
# macOS launchd provides one automatically. On Linux, start one if needed.
if ($env.SSH_AUTH_SOCK? | default "" | is-empty) {
  let agent_out = (ssh-agent -s | lines | first 2)
  let sock = ($agent_out | get 0 | parse "SSH_AUTH_SOCK={sock};" | get 0.sock)
  let pid = ($agent_out | get 1 | parse "SSH_AGENT_PID={pid};" | get 0.pid)
  $env.SSH_AUTH_SOCK = $sock
  $env.SSH_AGENT_PID = $pid
}

# Verify the agent is actually reachable. If SSH_AUTH_SOCK was inherited
# from the outer environment but points at a dead socket, fail loudly
# rather than silently routing ssh-add calls to a socket that will
# reject them.
let ssh_agent_ok = ((do { ssh-add -l } | complete).exit_code != 2)
if not $ssh_agent_ok {
  print -e $"(ansi { bg: red, attr: b }) Error (ansi reset) SSH agent unreachable"
  print -e $"  SSH_AUTH_SOCK=($env.SSH_AUTH_SOCK) is set but the socket is not responding."
  print -e "  Possible causes:"
  print -e "    - A stale socket path inherited from a previous session"
  print -e "    - An agent installed by another tool (1Password, Secretive, keychain, etc.)"
  print -e "    - A dead ssh-agent process"
  print -e ""
  print -e "  To recover this shell only:"
  print -e "    hide-env SSH_AUTH_SOCK; exec nu"
}

# === 1Password Service Account ===
# Uses a service account for non-interactive access to secrets and SSH keys.
# On first run, prompts to paste the service account token and saves it locally.

if not (which op | is-empty) {

let op_version = (op --version | split row '.' | first 2 | each { into int })
if ($op_version.0 < 2) or ($op_version.0 == 2 and $op_version.1 < 34) {
  print -e "warning: 1Password CLI >= 2.34 required for service account features"
  print -e "  Install: brew install --cask 1password-cli@beta"
} else {

  const op_token_file = "~/.config/op/service-account-token" | path expand
  if not ($op_token_file | path exists) {
    print -ne "1Password service account token not found."
    let prompt = "\r" + (ansi erase_entire_line) + "Paste your service account token (or press Enter to skip): "
    let token = (input -s $prompt | str trim)
    if ($token | is-not-empty) {
      $env.OP_SERVICE_ACCOUNT_TOKEN = $token
      print -ne $"\r(ansi erase_entire_line)Validating token..."
      let check = (do { op whoami } | complete)
      if $check.exit_code == 0 {
        mkdir ($op_token_file | path dirname)
        $token | save --raw $op_token_file
        chmod 600 $op_token_file
      } else {
        print -e $"\r(ansi erase_entire_line)warning: token validation failed, not saving"
        $env.OP_SERVICE_ACCOUNT_TOKEN = null
      }
    }
    print -ne $"\r(ansi erase_entire_line)"
  } else {
    $env.OP_SERVICE_ACCOUNT_TOKEN = (open --raw $op_token_file | str trim)
  }

  # Load SSH keys from the Develop vault — only keys not already in the agent
  if ($env.OP_SERVICE_ACCOUNT_TOKEN? != null) {
    if $ssh_agent_ok {
      print -ne "Connecting to 1Password..."
      try {
        let loaded = (do { ssh-add -l } | complete)
        let loaded_fps = if $loaded.exit_code == 0 {
          $loaded.stdout | lines | each { split row " " | get 1 }
        } else { [] }

        let vault_keys = (op item list --categories "SSH Key" --format json | from json)
        let missing = ($vault_keys | where { |key| $key.additional_information not-in $loaded_fps })

        if not ($missing | is-empty) {
          print -ne $"\r(ansi erase_entire_line)Adding SSH keys..."
          let private_keys = ($missing | par-each { |key|
            try {
              { title: $key.title, pem: (op read $"op://Develop/($key.id)/private key?ssh-format=openssh") }
            } catch {
              print -e $"warning: failed to read SSH key '($key.title)'"
              null
            }
          } | where { $in != null })
          let errors = ($private_keys | each { |pk|
            let result = ($"($pk.pem)\n" | ssh-add - | complete)
            if $result.exit_code != 0 {
              $"warning: failed to add SSH key '($pk.title)': ($result.stderr | str trim)"
            }
          } | where { $in != null })
          if not ($errors | is-empty) {
            print -e $"\r(ansi erase_entire_line)(ansi { bg: red, attr: b }) Error (ansi reset) Failed to add SSH keys"
            $errors | each { |e| print -e $e }
          }
        }
      } catch {
        print -e "warning: failed to list SSH keys from 1Password"
      }
    }

    # --- Secrets ---
    # Read environment variables directly from a 1Password Environment (CLI >= 2.34)
    print -ne $"\r(ansi erase_entire_line)Loading secrets..."
    const op_env_id = "eqonplojx5fxpgnmxfmyqotboi"
    let op_result = (do { op environment read $op_env_id } | complete)
    if $op_result.exit_code != 0 {
      print -e $"\r(ansi erase_entire_line)warning: failed to load secrets from 1Password \(exit ($op_result.exit_code)\)"
      let detail = ($op_result.stderr | str trim)
      if ($detail | is-not-empty) {
        $detail | lines | each { |l| print -e $"  ($l)" }
      }
    } else {
      try {
        $op_result.stdout
          | lines
          | where { |line| not ($line | str starts-with '#') and ($line | str contains '=') }
          | parse "{key}={value}"
          | reduce -f {} { |row, acc| $acc | insert $row.key $row.value }
          | load-env
      } catch { |err|
        print -e $"\r(ansi erase_entire_line)warning: failed to parse secrets from 1Password: ($err.msg)"
      }
    }
    print -ne $"\r(ansi erase_entire_line)"
  }

} # end: version check
} # end: 1Password

const work_env_file = "~/scripts/work-env.nu"
if ($work_env_file | path exists) {
  source-env $work_env_file
}

