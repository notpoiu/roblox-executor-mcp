# Roblox Executor MCP Server

An MCP server that bridges LLMs and a running Roblox Game Client — execute code, inspect scripts, spy on remotes, and more.

## Features

- **Code Execution & Data Querying** — Run Lua and fetch data from the game client.
- **Script Inspection** — Decompile LocalScripts/ModuleScripts and search across sources.
- **Instance Search** — CSS-like selectors via `QueryDescendants` and hierarchy trees.
- **Remote Spy** — [Cobalt](https://github.com/notpoiu/cobalt) integration to intercept, log, block, and ignore Remotes/Bindables.
- **Multi-Client** — Connect multiple Roblox clients simultaneously; target each by `clientId`. Dashboard at `http://localhost:16384/`.
- **Primary / Secondary** — Multiple MCP instances auto-coordinate; secondaries relay through the primary with automatic promotion.

## Prerequisites

- A Roblox executor supporting `loadstring`, `request`, and (preferably) `WebSocket`.
- Node.js ≥ 18.

## Quick Start

```bash
pnpm install && pnpm run build
```

### Add to your AI Client

**Cursor** — Settings > Features > MCP > Add: name `roblox-executor-mcp`, type `command`, command `node /path/to/MCPServer/dist/index.js`.

**Claude Desktop / Antigravity** — Add to your JSON config:
```json
{
  "mcpServers": {
    "roblox-executor-mcp": {
      "command": "node",
      "args": ["/path/to/MCPServer/dist/index.js"]
    }
  }
}
```

**Codex** — Settings > MCP Settings > Add server: name `roblox-executor-mcp`, type `STDIO`, command `node`, args `/path/to/MCPServer/dist/index.js`.

### Connect from Roblox

Run `connector.luau` in your executor, or use the quick loader:
```lua
-- getgenv().BridgeURL = "10.0.0.4:16384" (defaults to localhost, change if needed)
-- getgenv().DisableWebSocket = true
loadstring(game:HttpGet("https://raw.githubusercontent.com/notpoiu/roblox-executor-mcp/refs/heads/main/connector.luau"))()
```

## Tools

| Category | Tool | Description |
|---|---|---|
| **Execution** | `execute` | Run Lua code (actions) |
| | `get-data-by-code` | Run Lua code and return results |
| **Scripts** | `get-script-content` | Decompile a script's source |
| | `search-scripts-sources` | Search all scripts by source content |
| **Introspection** | `list-clients` | List connected clients |
| | `get-console-output` | Retrieve console logs |
| | `search-instances` | CSS-like instance search |
| | `get-descendants-tree` | Instance hierarchy tree |
| | `get-game-info` | Game metadata |
| **Remote Spy** | `ensure-remote-spy` | Load Cobalt (required first) |
| | `get-remote-spy-logs` | Get captured remote call logs |
| | `clear-remote-spy-logs` | Clear all logs |
| | `block-remote` | Block/unblock a remote |
| | `ignore-remote` | Ignore/unignore a remote |

## Security Note

This server allows arbitrary code execution in your Roblox client. Only use with trusted LLMs.
