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
$env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
  
# Directories to search for scripts when calling source or use
$env.NU_LIB_DIRS = [($env.HOME | path join 'scripts')]

# Directories to search for plugin binaries when calling register
$env.NU_PLUGIN_DIRS = [($env.HOME | path join 'plugins')]

# --- SSH Agent (persistent, shared across shells) ---
# Reuse ONE long-lived agent at a stable per-user socket so 1Password SSH keys
# load ONCE, not on every shell. The agent IS the key cache.
let agent_sock = ($env.HOME | path join ".ssh" "agent.sock")
mkdir ($agent_sock | path dirname)
let agent_live = ((do { with-env { SSH_AUTH_SOCK: $agent_sock } { ssh-add -l } } | complete).exit_code != 2)
if not $agent_live {
  rm -f $agent_sock
  ^ssh-agent -a $agent_sock o+e>| ignore
}
$env.SSH_AUTH_SOCK = $agent_sock

let ssh_agent_ok = ((do { ssh-add -l } | complete).exit_code != 2)
if not $ssh_agent_ok {
  print -e $"(ansi { bg: red, attr: b }) Error (ansi reset) SSH agent unreachable at ($agent_sock)"
}

# === 1Password (service account) — THROTTLED ===
if not (which op | is-empty) {
  let op_version = (op --version | split row '.' | first 2 | each { into int })
  if ($op_version.0 < 2) or ($op_version.0 == 2 and $op_version.1 < 34) {
    print -e "warning: 1Password CLI >= 2.34 required for service account features"
  } else {
    let op_token_file = ("~/.config/op/service-account-token" | path expand)
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

    if ($env.OP_SERVICE_ACCOUNT_TOKEN? != null) and $ssh_agent_ok {
      let op_dir = ("~/.config/op" | path expand)
      let sync_marker = ($op_dir | path join ".last-sync")
      let secrets_cache = ($op_dir | path join ".secrets-cache")
      let vault_fps_file = ($op_dir | path join ".vault-fingerprints")
      let op_env_id = "eqonplojx5fxpgnmxfmyqotboi"
      let throttle = 15min

      # Throttle on the marker ALONE (not on agent-has-keys): caps op attempts to
      # once per window even while rate-limited + agent-empty, so the fleet stops
      # hammering the shared service account and the limit can recover.
      let marker_recent = (($sync_marker | path exists) and (((date now) - (ls $sync_marker | get 0.modified)) < $throttle))

      if $marker_recent {
        # ---- THROTTLED: zero op calls. Secrets from cache. ----
        if ($secrets_cache | path exists) {
          open --raw $secrets_cache | lines
            | where { |l| (not ($l | str starts-with '#')) and ($l | str contains '=') }
            | parse "{key}={value}"
            | reduce -f {} { |row, acc| $acc | insert $row.key $row.value }
            | load-env
        }
      } else {
        # ---- FULL SYNC ----
        print -ne "Syncing 1Password..."
        # Set the throttle marker BEFORE any op call. If op hangs once, the marker
        # is still set, so the next shell throttles instead of every shell hanging.
        touch $sync_marker
        # KEYS: reconcile the agent to the vault (add missing; flush+reload on rotation).
        # op item list FAST-FAILS under rate-limit (no hang), so the try/catch alone
        # handles it — no timeout wrapper needed here.
        try {
          let vault_keys = (op item list --categories "SSH Key" --format json | from json)
          let vault_fps = ($vault_keys | get additional_information)
          let tracked = (if ($vault_fps_file | path exists) { open --raw $vault_fps_file | lines | where { |l| $l | is-not-empty } } else { [] })
          # rotation = a key we previously loaded is no longer in the vault
          let rotated_out = ($tracked | any { |fp| $fp not-in $vault_fps })
          if $rotated_out { ssh-add -D | complete | ignore }
          # (re)load every vault key not currently in the agent
          let loaded = (do { ssh-add -l } | complete)
          let agent_fps = (if $loaded.exit_code == 0 { $loaded.stdout | lines | each { |l| $l | split row " " | get 1 } } else { [] })
          $vault_keys | where { |k| $k.additional_information not-in $agent_fps } | each { |k|
            try {
              let pem = (op read $"op://Develop/($k.id)/private key?ssh-format=openssh")
              $"($pem)\n" | ssh-add - | complete | ignore
            } catch { print -e $"warning: failed to add SSH key '($k.title)'" }
          } | ignore
          $vault_fps | str join "\n" | save -f $vault_fps_file
        } catch {
          print -e "warning: 1Password key sync failed; using cached agent keys"
        }
        # SECRETS: refresh + cache; fall back to cache on failure (rate-limit/offline).
        # op environment read is the ONLY op call that HANGS (~120s) on a rate-limited
        # machine instead of fast-failing, which would wedge shell init — so bound it
        # with a 12s timeout via nushell's native job API (no external dep): run op in
        # a background job that sends its serialized complete-record back to the main
        # job, and block on `job recv --timeout 12sec`. If op hangs past 12s, recv
        # throws → fallback record (exit 124) → the cache fallback below; then kill the
        # still-hanging job. `job flush` first drops any stale mailbox message left by a
        # re-sourced env.nu. `job id` must be captured in the PARENT scope — inside the
        # spawned closure it returns the job's own id, not the parent's.
        job flush
        let op_job_parent = (job id)
        let op_job = (job spawn { (^op environment read $op_env_id | complete | to nuon) | job send $op_job_parent })
        let op_result = (try { (job recv --timeout 12sec) | from nuon } catch { { stdout: "", stderr: "op timed out", exit_code: 124 } })
        try { job kill $op_job }
        let secrets_raw = (if $op_result.exit_code == 0 {
          $op_result.stdout | save -f $secrets_cache
          chmod 600 $secrets_cache
          $op_result.stdout
        } else {
          print -e $"\r(ansi erase_entire_line)warning: 1Password secrets failed, exit ($op_result.exit_code); using cache"
          if ($secrets_cache | path exists) { open --raw $secrets_cache } else { "" }
        })
        $secrets_raw | lines
          | where { |l| (not ($l | str starts-with '#')) and ($l | str contains '=') }
          | parse "{key}={value}"
          | reduce -f {} { |row, acc| $acc | insert $row.key $row.value }
          | load-env
        print -ne $"\r(ansi erase_entire_line)"
      }
    }
  }
}


const work_env_file = "~/scripts/work-env.nu"
if ($work_env_file | path exists) {
  source-env $work_env_file
}

