# Resume Iris's conversation with her parent-only MCP configuration.
export def --wrapped main [...args: string] {
  let config = ($env.HOME | path join '.pi' 'agent' 'mcp-iris.json')
  if not ($config | path exists) {
    error make {msg: $"Iris MCP configuration is missing: ($config)"}
  }
  with-env {AUTONOMY_AGENT_ID: 'iris'} {
    ^pi --session '01a06a00-9635-73d4-9309-eec01f1a36e1' --mcp-config $config ...$args
  }
}
