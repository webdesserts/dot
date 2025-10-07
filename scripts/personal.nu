# Personal environment wrapper module
# Loads personal scripts/environment and optionally work-related modules
#
# Usage:
#   use ~/scripts/personal.nu *
#   # Now you have access to all personal commands and work commands (if available)

# Re-export common utility modules
export use ~/scripts/utils.nu *
export use ~/scripts/externs.nu *
export use ~/scripts/vscode.nu *

# Conditionally load work module (if it exists)
const work_module = "~/scripts/work.nu"
const work_module_path = if ($work_module | path exists) { $work_module } else { null }

export-env {
  if ($work_module_path != null) {
    use ~/scripts/work.nu
  }
}

export use $work_module_path *
