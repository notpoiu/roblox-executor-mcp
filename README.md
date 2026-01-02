# Roblox MCP Server

A Model Context Protocol (MCP) server that provides full control and introspection of a running Roblox Game Client. It acts as a bridge between LLMs and your Roblox game session.

## Features

- **Execute Code**: Run arbitrary Lua code in the Roblox client.
- **Data Querying**: Fetch complex data structures directly from the game.
- **Script Inspection**: Decompile and read the source of LocalScripts and ModuleScripts.
- **Console Access**: Retrieve developer console logs
- **Instance Searching**: Utilizes `QueryDescendants` to find parts, models, or any object in the game tree.

## Prerequisites

- **Roblox Executor**: You need a Roblox executor (like Seliware, Volt, etc) that supports `loadstring`, `HttpGet`, and _preferably_ `WebSocket`.
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
3. Set Name to `roblox-mcp`.
4. Set Type to `command`.
5. Command: `node /path/to/MCPServer/dist/index.js`.

#### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roblox-mcp": {
      "command": "node",
      "args": ["/path/to/MCPServer/dist/index.js"]
    }
  }
}
```

### 2. Connect from Roblox

In your Roblox executor, run the contents of `connector.luau`. You can also use this quick loader:

```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/notpoiu/robloxmcp/main/connector.luau"))()
```

_(Make sure to replace the URL with your actual hosted script or paste the file contents directly)_

## Available Tools

- `execute`: Runs Lua code. Use for actions (e.g., `game.Players.LocalPlayer.Character.Humanoid.Health = 0`).
- `get-data-by-code`: Runs Lua code and returns the result. Use for querying state (e.g., `return workspace.Part.Position`).
- `get-script-content`: Gets the decompiled output of a script via `scriptPath` (e.g., `game.Players.LocalPlayer.PlayerScripts.LocalScript`) or `scriptGetterSource` (more advanced).
- `get-console-output`: Returns the recent developer console logs.
- `search-instances`: Search for objects using a selector (e.g., `Part.Tagged[Anchored=false]`).
- `get-game-info`: Returns PlaceId, GameId, and more misc data.

## Security Note

This MCP server allows arbitrary code execution in your Roblox client. Only use it with LLMs you trust and in environments where you understand the risks.
