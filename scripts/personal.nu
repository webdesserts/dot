# Personal environment wrapper module
# Loads personal scripts/environment and optionally work-related modules
#
# Usage:
#   use ~/scripts/personal.nu *
#   # Now you have access to all personal commands and work commands (if on rhea)

# Re-export common utility modules
export use ~/scripts/utils.nu *
export use ~/scripts/externs.nu *
export use ~/scripts/vscode.nu *
export use ~/scripts/piano.nu *

# Conditionally load work module (rhea only)
export-env {
  if ((sys host | get hostname) =~ "rhea") and ("~/scripts/work.nu" | path expand | path exists) {
    use ~/scripts/work.nu
  }
}
