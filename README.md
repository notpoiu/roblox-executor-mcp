# Roblox MCP Server

A Model Context Protocol (MCP) server that provides full control and introspection of a running Roblox Game Client. It acts as a bridge between LLMs and your Roblox game session.

## Features

- **Execute Code**: Run arbitrary Lua code in the Roblox client.
- **Data Querying**: Fetch complex data structures directly from the game.
- **Script Inspection**: Decompile and read the source of LocalScripts and ModuleScripts.
- **Console Access**: Retrieve developer console logs.
- **Instance Searching**: Utilizes `QueryDescendants` to find parts, models, or any object in the game tree.
- **Remote Spy**: Integrates with [Cobalt](https://github.com/notpoiu/cobalt) to intercept, log, block, and ignore RemoteEvents, RemoteFunctions, BindableEvents, and BindableFunctions.
- **Primary / Secondary Architecture**: Multiple MCP server instances can run simultaneously. The first instance becomes the **primary** (owns the HTTP/WebSocket bridge), while subsequent instances automatically connect as **secondaries** via a relay. If the primary goes down, a secondary is promoted automatically.
- **Multi-Instance / Multi-Executor Support**: Connect multiple Roblox clients (different games, accounts, or executors) at the same time. Each client is registered with a unique `clientId` and can be targeted individually through any tool. Use `list-clients` to discover all connected clients. A built-in dashboard UI provides a live overview of every connected client.

## Prerequisites

- **Roblox Executor**: You need a Roblox executor (like Seliware, Volt, etc) that supports `loadstring`, `request`, and _preferably_ `WebSocket`.
- **Node.js**: Version 18 or higher.

## Installation

1.  **Clone or download** this repository.
2.  Install dependencies:
    ```bash
    pnpm install
    ```
3.  Build the project:
    ```bash
    pnpm run build
    ```

## Usage

### 1. Add to your AI Client

#### Cursor

1. Go to **Settings > Cursor Settings > Features > MCP**.
2. Click **+ Add New MCP Server**.
3. Set Name to `roblox-executor-mcp`.
4. Set Type to `command`.
5. Command: `node /path/to/MCPServer/dist/index.js`.

#### Claude Desktop

Add this to your `claude_desktop_config.json`:

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

#### Antigravity

1. Open your chat side panel
2. Press on the 3 dots next to the chat close button
3. Click on "MCP Servers"
4. Click on "Manage MCP Servers"
5. Click on "View raw config"
6. Paste the following JSON:
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

#### Codex

1. Go to **Settings > MCP Settings**
2. Click **⚙️ Open MCP Settings**
3. Click on **+ Add server**
4. Set Type to `STDIO`
5. Set Command to `node`
6. Set Arguments to `/path/to/MCPServer/dist/index.js`
7. Click **Save**

### 2. Connect from Roblox

In your Roblox executor, run the contents of `connector.luau`. You can also use this quick loader:

```lua
-- getgenv().BridgeURL = "10.0.0.4:16384" (defaults to localhost, dont change unless you know what you are doing!)
-- getgenv().DisableWebSocket = true
loadstring(game:HttpGet("https://raw.githubusercontent.com/notpoiu/roblox-mcp/refs/heads/main/connector.luau"))()
```


## Available Tools

### Code Execution
- `execute` — Runs Lua code in the game client. Use for actions (e.g., modifying game state).
- `get-data-by-code` — Runs Lua code and returns the result. Use for querying state.

### Script Inspection
- `get-script-content` — Gets the decompiled source of a script via `scriptPath` or `scriptGetterSource`.
- `search-scripts-sources` — Search across all scripts by source code content.

### Game Introspection
- `list-clients` — Lists all connected Roblox clients with their `clientId`, username, placeId, jobId, and placeName.
- `get-console-output` — Returns recent developer console logs.
- `search-instances` — Search for objects using CSS-like selectors (e.g., `Part.Tagged[Anchored=false]`).
- `get-descendants-tree` — Returns a structured hierarchy tree of an instance's descendants with optional class filtering.
- `get-game-info` — Returns PlaceId, GameId, PlaceVersion, and other metadata.

### Remote Spy (Cobalt)
- `ensure-remote-spy` — Loads the [Cobalt](https://github.com/notpoiu/cobalt) remote spy if not already running. Must be called before using other remote spy tools.
- `get-remote-spy-logs` — Retrieves captured remote/bindable call logs with filtering by direction, remote name, and call count.
- `clear-remote-spy-logs` — Clears all captured remote spy logs.
- `block-remote` — Blocks or unblocks a specific remote event/function (prevents calls from reaching server/client).
- `ignore-remote` — Ignores or unignores a specific remote (calls still fire but won't be logged).

## Security Note

This MCP server allows arbitrary code execution in your Roblox client. Only use it with LLMs you trust and in environments where you understand the risks.
