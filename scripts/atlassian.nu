# Atlassian configuration loaded from environment variables
# The following environment variables MUST be defined in your shell config:
# - ATLASSIAN_SITE: Your Atlassian/Jira site (e.g., "yourcompany.atlassian.net")
# - ATLASSIAN_EMAIL: Your email for Atlassian authentication
# - ATLASSIAN_TOKEN: API token for Jira/Atlassian authentication
# - BITBUCKET_TOKEN: API token for Bitbucket authentication
#
# Commands will provide clear error messages if these are not set.

def "get-jira-config" []: nothing -> record {
  if 'ATLASSIAN_SITE' not-in $env {
    error make {msg: "ATLASSIAN_SITE environment variable is not set. Please set it in your shell config."}
  }
  if 'ATLASSIAN_EMAIL' not-in $env {
    error make {msg: "ATLASSIAN_EMAIL environment variable is not set. Please set it in your shell config."}
  }
  if 'ATLASSIAN_TOKEN' not-in $env {
    error make {msg: "ATLASSIAN_TOKEN environment variable is not set. Please set it in your shell config."}
  }

  {
    site: $env.ATLASSIAN_SITE
    email: $env.ATLASSIAN_EMAIL
    token: $env.ATLASSIAN_TOKEN
  }
}

def "get-bitbucket-config" []: nothing -> record {
  if 'ATLASSIAN_EMAIL' not-in $env {
    error make {msg: "ATLASSIAN_EMAIL environment variable is not set. Please set it in your shell config."}
  }
  if 'BITBUCKET_TOKEN' not-in $env {
    error make {msg: "BITBUCKET_TOKEN environment variable is not set. Please set it in your shell config."}
  }

  {
    email: $env.ATLASSIAN_EMAIL
    token: $env.BITBUCKET_TOKEN
  }
}

# Jira CLI - Interact with Jira tickets via REST API
#
# Quick help guide:
#   jira                - Show this usage information
#   jira --help         - Show all available commands (nushell help)
#   jira issue          - Show issue commands
#   jira issue --help   - Show all issue subcommands (nushell help)
#   help jira issue view - Show detailed help for specific command
#
# Main commands:
#   jira issue ...      - Work with tickets (view, create, update, transition, types)
#   jira comment ...    - Work with comments (add)
#   jira search <jql>   - Search tickets using JQL
#   jira fields         - List field IDs and names
export def jira [] {
  print "Jira CLI - Interact with Jira tickets via REST API"
  print ""
  print "Usage:"
  print "  jira issue ...      - Work with tickets (view, create, update, transition, types)"
  print "  jira comment ...    - Work with comments (add)"
  print "  jira search <jql>   - Search tickets using JQL"
  print "  jira fields         - List field IDs and names"
  print ""
  print "Quick help:"
  print "  jira --help              - Show all available commands"
  print "  jira issue               - Show issue commands"
  print "  help jira issue view     - Show detailed help for specific command"
}

# Parse git remote URL to extract Bitbucket workspace and repo
def get-bitbucket-repo []: nothing -> record {
  let remote_url = (git remote get-url origin | str trim)

  # Handle SSH format: git@bitbucket.org:workspace/repo.git
  let parts = ($remote_url | parse "git@bitbucket.org:{workspace}/{repo}.git")

  if ($parts | is-empty) {
    error make {msg: "Could not parse Bitbucket remote URL. Expected format: git@bitbucket.org:workspace/repo.git"}
  }

  $parts | first
}

# Get headers for Bitbucket API requests
def get-bitbucket-headers []: nothing -> record {
  let config = (get-bitbucket-config)
  let auth = ($"($config.email):($config.token)" | encode base64)
  {
    "Content-Type": "application/json",
    "Authorization": $"Basic ($auth)"
  }
}

# Get headers for Jira API requests
def get-jira-headers []: nothing -> record {
  let config = (get-jira-config)
  let auth = ($"($config.email):($config.token)" | encode base64)
  {
    "Content-Type": "application/json",
    "Authorization": $"Basic ($auth)"
  }
}

  # Issue commands - work with Jira tickets
  export def "jira issue" [] {
    print "Jira Issue Commands"
    print ""
    print "Usage:"
    print "  jira issue view <ticket>                - View ticket details"
    print "  jira issue update <ticket> <payload>    - Update ticket fields"
    print "  jira issue create <project> <type> ...  - Create new ticket"
    print "  jira issue transition <ticket> <status> - Move ticket between statuses"
    print "  jira issue types [--project]            - List available issue types"
    print ""
    print "Run 'help jira issue <command>' for detailed usage"
  }

  # View a Jira ticket with all fields
  #
  # Returns JSON with all ticket data including custom fields
  #
  # Example:
  #   jira issue view LOR-4262
  #   jira issue view LOR-4262 | get fields.summary
  #   jira issue view LOR-4262 | get fields.customfield_10039  # Acceptance Criteria
  export def "jira issue view" [ticket: string]: nothing -> record {
    let config = (get-jira-config)
    let headers = (get-jira-headers)
    http get $"https://($config.site)/rest/api/3/issue/($ticket)" --headers $headers
  }

  # Update a Jira ticket with JSON payload
  #
  # Accepts JSON string with fields to update (uses Atlassian Document Format for text fields)
  #
  # Example:
  #   jira issue update LOR-4262 '{"fields": {"summary": "New title"}}'
  #   jira issue update LOR-4262 '{"fields": {"customfield_10039": {...}}}'  # Update Acceptance Criteria
  export def "jira issue update" [
    ticket: string,
    payload: string
  ]: nothing -> any {
    let config = (get-jira-config)
    let headers = (get-jira-headers)
    http put $"https://($config.site)/rest/api/3/issue/($ticket)" $payload --headers $headers --content-type "application/json"
  }

  # Create a new Jira ticket
  #
  # Create tickets for bugs, tech debt, or new stories
  #
  # Example:
  #   jira issue create LOR Task "Refactor authentication module"
  #   jira issue create LOR Bug "Login button not working" --description "Users can't log in on mobile"
  #   jira issue create LOR Story "Add dark mode support"
  export def "jira issue create" [
    project: string,     # Project key (e.g., "LOR")
    type: string,        # Issue type (e.g., "Story", "Bug", "Task")
    summary: string,     # Ticket summary/title
    --description: string = ""  # Optional description
  ]: nothing -> record {
    let desc_content = if ($description | is-empty) {
      []
    } else {
      [{
        type: "paragraph",
        content: [{
          type: "text",
          text: $description
        }]
      }]
    }

    let payload = ({
      fields: {
        project: { key: $project },
        issuetype: { name: $type },
        summary: $summary,
        description: {
          type: "doc",
          version: 1,
          content: $desc_content
        }
      }
    } | to json)

    let config = (get-jira-config)
    let headers = (get-jira-headers)
    http post $"https://($config.site)/rest/api/3/issue" $payload --headers $headers --content-type "application/json"
  }

  # Transition a ticket to a new status
  #
  # Move a ticket through workflow states. Error shows available transitions if status not found.
  #
  # Example:
  #   jira issue transition LOR-4262 "In Progress"    # Start work on a ticket
  #   jira issue transition LOR-4262 "Done"           # Mark ticket complete
  #   jira issue transition LOR-4262 "Ready"          # Move to Ready status
  export def "jira issue transition" [
    ticket: string,      # Ticket ID (e.g., LOR-4262)
    status: string       # Target status name (e.g., "In Progress", "Done")
  ]: nothing -> any {
    let config = (get-jira-config)
    let headers = (get-jira-headers)

    # Get available transitions
    let transitions = (http get $"https://($config.site)/rest/api/3/issue/($ticket)/transitions" --headers $headers)

    # Find the transition ID that matches the target status
    let transition_id = ($transitions.transitions | where ($it.to.name == $status) | get 0.id? | default null)

    if ($transition_id == null) {
      error make {msg: $"No transition to '($status)' found. Available transitions: ($transitions.transitions | get to.name | str join ', ')"}
    }

    # Execute the transition
    let payload = ({transition: {id: $transition_id}} | to json)
    http post $"https://($config.site)/rest/api/3/issue/($ticket)/transitions" $payload --headers $headers --content-type "application/json"
  }

  # List available issue types
  #
  # Shows what ticket types you can create (Story, Bug, Task, etc.)
  #
  # Example:
  #   jira issue types                    # List all issue types
  #   jira issue types --project LOR      # List types available for LOR project
  export def "jira issue types" [
    --project: string = ""  # Optional project key to filter types
  ]: nothing -> table {
    let config = (get-jira-config)
    let headers = (get-jira-headers)

    if ($project | is-empty) {
      http get $"https://($config.site)/rest/api/3/issuetype" --headers $headers | select id name description
    } else {
      # Get project-specific issue types from createmeta
      let createmeta = (http get $"https://($config.site)/rest/api/3/issue/createmeta?projectKeys=($project)&expand=projects.issuetypes" --headers $headers)
      $createmeta.projects.0.issuetypes | select id name description
    }
  }

  # Comment commands - work with ticket comments
  export def "jira comment" [] {
    print "Jira Comment Commands"
    print ""
    print "Usage:"
    print "  jira comment add <ticket> <text>        - Add comment to ticket"
    print ""
    print "Run 'help jira comment <command>' for detailed usage"
  }

  # Add a comment to a ticket
  #
  # Post a comment with progress updates or notes
  #
  # Example:
  #   jira comment add LOR-4262 "Started implementation"
  #   jira comment add LOR-4262 "Fixed the issue, ready for review"
  export def "jira comment add" [
    ticket: string,  # Ticket ID (e.g., LOR-4262)
    text: string     # Comment text
  ]: nothing -> record {
    let payload = ({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: $text
              }
            ]
          }
        ]
      }
    } | to json)

    let config = (get-jira-config)
    let headers = (get-jira-headers)
    http post $"https://($config.site)/rest/api/3/issue/($ticket)/comment" $payload --headers $headers --content-type "application/json"
  }

  # Search for Jira tickets using JQL
  #
  # Returns JSON with matching tickets
  #
  # Example:
  #   jira search 'project = LOR AND status = "In Progress"'
  #   jira search 'assignee = currentUser() AND status != Done'
  #   jira search 'project = LOR' | get issues | select key fields.summary
  export def "jira search" [jql: string]: nothing -> record {
    let encoded_jql = ($jql | url encode)
    let config = (get-jira-config)
    let headers = (get-jira-headers)
    http get $"https://($config.site)/rest/api/3/search?jql=($encoded_jql)" --headers $headers
  }

  # List all fields with their IDs and names
  #
  # Useful for finding custom field IDs needed for updates
  #
  # Example:
  #   jira fields                        # List all fields
  #   jira fields --filter acceptance    # Find Acceptance Criteria fields
  #   jira fields --filter date          # Find date-related fields
  export def "jira fields" [
    --filter: string = ""  # Optional filter pattern for field names
  ]: nothing -> table {
    let config = (get-jira-config)
    let headers = (get-jira-headers)
    let all_fields = (http get $"https://($config.site)/rest/api/3/field" --headers $headers)

    if ($filter | is-empty) {
      $all_fields | select id name custom
    } else {
      $all_fields | where ($it.name | str downcase | str contains ($filter | str downcase)) | select id name custom
    }
  }

# Bitbucket CLI - Interact with Bitbucket pull requests via REST API
#
# Quick help guide:
#   bitbucket             - Show this usage information
#   bitbucket --help      - Show all available commands (nushell help)
#   bitbucket pr          - Show PR commands
#   help bitbucket pr list - Show detailed help for specific command
#
# Main commands:
#   bitbucket pr list   - List pull requests for current repo
#   bitbucket pr view   - View specific pull request details
export def bitbucket [] {
  print "Bitbucket CLI - Interact with Bitbucket pull requests via REST API"
  print ""
  print "Usage:"
  print "  bitbucket pr list   - List pull requests for current repo"
  print "  bitbucket pr view   - View specific pull request details"
  print ""
  print "Quick help:"
  print "  bitbucket --help         - Show all available commands"
  print "  bitbucket pr             - Show PR commands"
  print "  help bitbucket pr list   - Show detailed help for specific command"
}

# PR commands - work with Bitbucket pull requests
export def "bitbucket pr" [] {
  print "Usage: bitbucket pr <command>"
  print ""
  print "Run 'help bitbucket pr' to see available commands"
}

# List pull requests for the current repository
#
# Lists PRs from the current git repository (auto-detected from git remote).
# Filter by state, search text, or branch names.
# By default returns first page. Use --all to fetch all pages (max 1000 items).
#
# Example:
#   bitbucket pr list                                    # List open PRs (first page)
#   bitbucket pr list --all                              # List all open PRs (all pages, max 1000)
#   bitbucket pr list --state MERGED                     # List merged PRs
#   bitbucket pr list --search LOR-4838                  # Search by Jira ticket in title/description
#   bitbucket pr list --source "feature/LOR-4838"        # Filter by source branch
#   bitbucket pr list --destination "main"               # Filter by destination branch
#   bitbucket pr list --state OPEN --search "fix bug"    # Combined filters
export def "bitbucket pr list" [
  --state: string = "OPEN"       # PR state: OPEN, MERGED, DECLINED, SUPERSEDED
  --search: string = ""          # Search text in title or description
  --source: string = ""          # Filter by source branch name
  --destination: string = ""     # Filter by destination branch name
  --all                          # Fetch all pages (default: first page only, max 1000 items)
]: nothing -> table {
  let headers = (get-bitbucket-headers)
  let repo = (get-bitbucket-repo)

  mut all_prs = []
  mut next_url = $"/pullrequests?state=($state)&pagelen=20"
  let max_items = 1000

  loop {
    let response = if ($next_url | str starts-with "http") {
      http get $next_url --headers $headers
    } else {
      let url = $"https://api.bitbucket.org/2.0/repositories/($repo.workspace)/($repo.repo)($next_url)"
      http get $url --headers $headers
    }

    # Handle error responses
    if ($response.type? == "error") {
      error make {msg: $"Bitbucket API error: ($response.error.message)"}
    }

    $all_prs = ($all_prs | append $response.values)

    # Stop if we've hit the max, or if not fetching all pages, or no more pages
    if ($all_prs | length) >= $max_items or (not $all) or ($response.next? == null) {
      break
    }

    $next_url = $response.next
  }

  # Limit to max_items
  let prs = ($all_prs | first $max_items)

  # Apply search filter (title or description)
  let search_filtered = if ($search | is-empty) {
    $prs
  } else {
    $prs | where {|pr|
      let title_match = ($pr.title | str downcase | str contains ($search | str downcase))
      let desc_match = ($pr.description | str downcase | str contains ($search | str downcase))
      $title_match or $desc_match
    }
  }

  # Apply source branch filter
  let source_filtered = if ($source | is-empty) {
    $search_filtered
  } else {
    $search_filtered | where {|pr|
      $pr.source.branch.name | str downcase | str contains ($source | str downcase)
    }
  }

  # Apply destination branch filter
  let filtered = if ($destination | is-empty) {
    $source_filtered
  } else {
    $source_filtered | where {|pr|
      $pr.destination.branch.name | str downcase | str contains ($destination | str downcase)
    }
  }

  $filtered | each {|pr|
    {
      id: $pr.id,
      title: $pr.title,
      state: $pr.state,
      author: $pr.author.display_name,
      source: $pr.source.branch.name,
      destination: $pr.destination.branch.name,
      created_on: $pr.created_on
    }
  }
}

# View details of a specific pull request
#
# Returns full PR information for the given PR ID.
# The response is a nushell record that can be piped to get specific fields.
#
# Example:
#   bitbucket pr view 123                 # View full PR details
#   bitbucket pr view 123 | get title     # Get just the title
#   bitbucket pr view 123 | get author    # Get author info
#   bitbucket pr view 123 | get links.html.href  # Get PR URL
export def "bitbucket pr view" [
  id: int  # Pull request ID number
]: nothing -> record {
  let headers = (get-bitbucket-headers)
  let repo = (get-bitbucket-repo)
  let url = $"https://api.bitbucket.org/2.0/repositories/($repo.workspace)/($repo.repo)/pullrequests/($id)"
  http get $url --headers $headers
}

# Create a new pull request
#
# Creates a PR from source branch to destination branch.
# If destination is not specified, defaults to the repository's default branch.
#
# Example:
#   bitbucket pr create "Fix bug" "feature/fix-123"                    # PR to default branch
#   bitbucket pr create "New feature" "feature/new" "develop"          # PR to develop
#   bitbucket pr create "Fix" "bugfix" "main" --description "Details"  # With description
#   bitbucket pr create "WIP: Feature" "feature/wip" --draft           # Create as draft PR
export def "bitbucket pr create" [
  title: string           # PR title
  source: string          # Source branch name
  destination?: string    # Destination branch name (optional, defaults to repo default)
  --description: string = ""  # PR description (optional)
  --draft                 # Create as draft PR (prevents merging, reviewers not notified)
]: nothing -> record {
  let base_payload = if ($destination == null) {
    {
      title: $title,
      source: {
        branch: {
          name: $source
        }
      },
      description: $description
    }
  } else {
    {
      title: $title,
      source: {
        branch: {
          name: $source
        }
      },
      destination: {
        branch: {
          name: $destination
        }
      },
      description: $description
    }
  }

  let payload = if $draft {
    $base_payload | insert draft true
  } else {
    $base_payload
  }

  let headers = (get-bitbucket-headers)
  let repo = (get-bitbucket-repo)
  let url = $"https://api.bitbucket.org/2.0/repositories/($repo.workspace)/($repo.repo)/pullrequests"
  http post $url ($payload | to json) --headers $headers --content-type "application/json"
}

# Edit an existing pull request
#
# Updates PR fields like title or description.
# Can pass JSON directly or use --title/--description flags.
#
# Example:
#   bitbucket pr edit 123 --title "New title"                    # Update title
#   bitbucket pr edit 123 --description "New description"        # Update description
#   bitbucket pr edit 123 --title "Title" --description "Desc"   # Update both
export def "bitbucket pr edit" [
  id: int                     # Pull request ID number
  --title: string             # New PR title
  --description: string       # New PR description
  --payload: string           # Raw JSON payload (for advanced updates)
]: nothing -> record {
  let data = if ($payload != null) {
    $payload
  } else {
    let updates = {}
      | if ($title != null) { $in | insert title $title } else { $in }
      | if ($description != null) { $in | insert description $description } else { $in }

    if ($updates | is-empty) {
      error make {msg: "Must provide --title, --description, or --payload"}
    }

    $updates | to json
  }

  let headers = (get-bitbucket-headers)
  let repo = (get-bitbucket-repo)
  let url = $"https://api.bitbucket.org/2.0/repositories/($repo.workspace)/($repo.repo)/pullrequests/($id)"
  http put $url $data --headers $headers --content-type "application/json"
}

# Comment commands - work with PR comments
export def "bitbucket pr comment" [] {
  print "Usage: bitbucket pr comment <command>"
  print ""
  print "Run 'help bitbucket pr comment' to see available commands"
}

# Add a comment to a pull request
#
# Posts a comment to the specified pull request.
#
# Example:
#   bitbucket pr comment create 123 "Looks good to me!"
#   bitbucket pr comment create 123 "Please fix the tests"
export def "bitbucket pr comment create" [
  id: int      # Pull request ID number
  text: string # Comment text
]: nothing -> record {
  let payload = {
    content: {
      raw: $text
    }
  }

  let headers = (get-bitbucket-headers)
  let repo = (get-bitbucket-repo)
  let url = $"https://api.bitbucket.org/2.0/repositories/($repo.workspace)/($repo.repo)/pullrequests/($id)/comments"
  http post $url ($payload | to json) --headers $headers --content-type "application/json"
}

# Decline a pull request
#
# Declines (closes) a pull request without merging.
# Optionally add a message explaining why the PR was declined.
#
# NOTE: The --message parameter uses an undocumented API behavior that may not work.
# See: https://community.atlassian.com/t5/Bitbucket-questions/How-do-you-specify-a-reason-when-you-are-declining-a-Pull/qaq-p/1099355
# If the message doesn't appear, use `bitbucket pr comment` before declining.
#
# Example:
#   bitbucket pr decline 123                                    # Decline without message
#   bitbucket pr decline 123 --message "Changes merged in PR #456"  # Decline with reason
export def "bitbucket pr decline" [
  id: int                # Pull request ID number
  --message: string = "" # Optional decline reason/message (may not work - see NOTE above)
]: nothing -> any {
  let headers = (get-bitbucket-headers)
  let repo = (get-bitbucket-repo)
  let url = $"https://api.bitbucket.org/2.0/repositories/($repo.workspace)/($repo.repo)/pullrequests/($id)/decline"

  if ($message | is-empty) {
    http post $url --headers $headers
  } else {
    let data = {
      content: {
        raw: $message
      }
    } | to json
    http post $url $data --headers $headers --content-type "application/json"
  }
}
