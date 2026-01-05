#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebSocketServer, WebSocket } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import crypto from "crypto";

const WS_PORT = 16384;
const HTTP_POLL_TIMEOUT = 10000; // 10 seconds

const STATUS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roblox MCP Status</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=JetBrains+Mono&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0a0a0c;
            --card: rgba(20, 20, 25, 0.7);
            --border: rgba(255, 255, 255, 0.1);
            --primary: #5865F2;
            --success: #10b981;
            --error: #ef4444;
            --text: #ffffff;
            --text-dim: #94a3b8;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background: var(--bg);
            background-image: 
                radial-gradient(at 0% 0%, rgba(88, 101, 242, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.1) 0px, transparent 50%);
            color: var(--text);
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }

        .container {
            width: 100%;
            max-width: 480px;
            padding: 2rem;
            position: relative;
        }

        .card {
            background: var(--card);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 3rem 2rem;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .status-blob {
            width: 120px;
            height: 120px;
            margin: 0 auto 2rem;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .status-icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2.5rem;
            z-index: 2;
            transition: all 0.5s ease;
        }

        .status-ring {
            position: absolute;
            width: 100%;
            height: 100%;
            border-radius: 50%;
            border: 2px solid transparent;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(0.8); opacity: 1; }
            100% { transform: scale(1.3); opacity: 0; }
        }

        /* Connected State */
        .connected .status-icon {
            background: rgba(16, 185, 129, 0.2);
            color: var(--success);
            box-shadow: 0 0 30px rgba(16, 185, 129, 0.2);
        }
        .connected .status-ring { border-color: var(--success); }

        /* Disconnected State */
        .disconnected .status-icon {
            background: rgba(239, 68, 68, 0.2);
            color: var(--error);
            box-shadow: 0 0 30px rgba(239, 68, 68, 0.2);
        }
        .disconnected .status-ring { border-color: var(--error); }

        h1 {
            font-size: 2rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            letter-spacing: -0.02em;
        }

        .subtext {
            color: var(--text-dim);
            font-size: 1.1rem;
            margin-bottom: 2.5rem;
        }

        .stats {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
            border-top: 1px solid var(--border);
            padding-top: 2rem;
        }

        .stat-item {
            text-align: left;
            padding: 0.5rem;
        }

        .stat-label {
            color: var(--text-dim);
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 0.25rem;
        }

        .stat-value {
            font-family: 'JetBrains Mono', monospace;
            font-size: 1rem;
            color: var(--primary);
        }

        .badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 99px;
            font-size: 0.75rem;
            font-weight: 600;
            background: var(--primary);
            color: white;
            margin-bottom: 1.5rem;
        }
    </style>
</head>
<body>
    <div class="container" id="app">
        <div class="card disconnected" id="statusCard">
            <div class="badge">Roblox MCP Server</div>
            <div class="status-blob">
                <div class="status-ring"></div>
                <div class="status-icon">
                    <span id="statusEmoji">×</span>
                </div>
            </div>
            <h1 id="statusText">Disconnected</h1>
            <p class="subtext" id="subText">Waiting for Roblox client...</p>
            
            <div class="stats">
                <div class="stat-item">
                    <div class="stat-label">Connection</div>
                    <div class="stat-value" id="methodValue">None</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Clients</div>
                    <div class="stat-value" id="clientCount">0</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const statusCard = document.getElementById('statusCard');
        const statusText = document.getElementById('statusText');
        const subText = document.getElementById('subText');
        const statusEmoji = document.getElementById('statusEmoji');
        const methodValue = document.getElementById('methodValue');
        const clientCountValue = document.getElementById('clientCount');

        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                if (data.connected) {
                    statusCard.className = 'card connected';
                    statusText.innerText = 'Connected';
                    subText.innerText = '';
                    statusEmoji.innerText = '✓';
                } else {
                    statusCard.className = 'card disconnected';
                    statusText.innerText = 'Disconnected';
                    statusEmoji.innerText = '×';
                }

                methodValue.innerText = data.method;
                clientCountValue.innerText = data.clientCount;
            } catch (e) {
                statusCard.className = 'card disconnected';
                statusText.innerText = 'Offline';
                statusEmoji.innerText = '!';
                methodValue.innerText = 'Error';
            }
        }

        setInterval(updateStatus, 2000);
        updateStatus();
    </script>
</body>
</html>
`;

function killProcessOnPort(port: number) {
  try {
    const pid = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
    if (pid) {
      console.error(`Killing existing process ${pid} on port ${port}...`);
      execSync(`kill -9 ${pid}`);
    }
  } catch {}
}

// Commented out cuz its only for local testing
// killProcessOnPort(WS_PORT);

// MCP Server
const server = new McpServer({
  name: "RobloxMCP",
  version: "1.0.0",
  description:
    "A MCP Server allowing interaction to the Roblox Game Client (including access to restricted APIs such as getgc(), getreg(), etc.) with full control over the game.",
});

// HTTP polling state
let lastHttpPollTime = 0;
let pendingHttpCommand: any = null;
let httpResponseResolvers: Map<string, (data: any) => void> = new Map();

// HTTP server for HTTP polling fallback
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${WS_PORT}`);

  // Root status page
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(STATUS_PAGE_HTML);
    return;
  }

  // API Status for dashboard polling
  if (url.pathname === "/api/status" && req.method === "GET") {
    const wsClients = Array.from(wss.clients).filter(
      (c) => c.readyState === WebSocket.OPEN
    ).length;
    const isHttpConnected = Date.now() - lastHttpPollTime < HTTP_POLL_TIMEOUT;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        connected: wsClients > 0 || isHttpConnected,
        method: wsClients > 0 ? "WebSocket" : isHttpConnected ? "HTTP" : "None",
        clientCount: wsClients + (isHttpConnected ? 1 : 0),
      })
    );
    return;
  }

  // HTTP polling - return pending command if any
  if (url.pathname === "/poll" && req.method === "GET") {
    lastHttpPollTime = Date.now();

    if (pendingHttpCommand) {
      const cmd = pendingHttpCommand;
      pendingHttpCommand = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(cmd);
    } else {
      res.writeHead(204);
      res.end();
    }
    return;
  }

  // HTTP polling - receive response from client
  if (url.pathname === "/respond" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data.id && httpResponseResolvers.has(data.id)) {
          httpResponseResolvers.get(data.id)?.(data);
          httpResponseResolvers.delete(data.id);
        }

        res.writeHead(200);
        res.end("OK");
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });
    return;
  }

  res.writeHead(200);
  res.end("MCP Server Running");
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(WS_PORT, () => {
  console.error(`MCP Bridge listening on port ${WS_PORT} (WebSocket + HTTP)`);
});

function hasConnectedClients(): boolean {
  // WebSocket clients
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      return true;
    }
  }

  // HTTP polling client (with timeout check)
  return Date.now() - lastHttpPollTime < HTTP_POLL_TIMEOUT;
}

const NO_CLIENT_ERROR = {
  content: [
    {
      type: "text" as const,
      text: "No Roblox client connected to the MCP server. Please notify the user that they have to run the connector.luau script in order to connect the MCP server to their game.",
    },
  ],
};

function GetResponseOfIdFromClient(id: string): Promise<any> {
  return new Promise((resolve) => {
    // Check if we have WebSocket clients
    let hasWsClient = false;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        hasWsClient = true;

        // On message event handler
        client.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          if (data.id === id) {
            resolve(data);
          }
        };
      }
    }

    // HTTP response resolver if no WebSocket client
    if (!hasWsClient) {
      httpResponseResolvers.set(id, resolve);
    }
  });
}

function SendToClients(message: string) {
  // WebSocket clients
  let hasWsClient = false;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      hasWsClient = true;
      client.send(message);
    }
  });

  // Queue for HTTP polling
  if (!hasWsClient) {
    pendingHttpCommand = message;
  }
}

function SendArbitraryDataToClient(
  type: string,
  data: any,
  id: string | undefined = undefined
) {
  if (!hasConnectedClients()) {
    return null;
  }

  if (id === undefined) {
    id = crypto.randomUUID();
  }

  const message = {
    id,
    ...data,
    type,
  };

  SendToClients(JSON.stringify(message));

  return id;
}

server.registerTool(
  "execute",
  {
    title: "Execute Code in the Roblox Game Client",
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "The code to execute in the Roblox Game Client. This tool does NOT return output - use get-data-by-code if you need to retrieve data."
        ),
      threadContext: z
        .number()
        .describe(
          "The thread identity to execute the code in (default: 8, normal game scripts run on 2)"
        )
        .optional()
        .default(8),
    }),
  },
  async ({ code, threadContext }) => {
    console.error(`Executing code in thread ${threadContext}...`);

    const result = SendArbitraryDataToClient("execute", {
      source: `setthreadidentity(${threadContext})\n${code}`,
    });

    if (result === null) {
      return NO_CLIENT_ERROR;
    }

    return {
      content: [
        {
          type: "text",
          text: `Code has been scheduled to be run in thread context ${threadContext}.`,
        },
      ],
    };
  }
);

server.registerTool(
  "get-script-content",
  {
    title: "Get the content of a script in the Roblox Game Client",
    description: "Get the content of a script in the Roblox Game Client",
    inputSchema: z.object({
      scriptGetterSource: z
        .string()
        .describe(
          "The code that fetches the script object from the game (should return a script object, and MUST be client-side only, will not work on Scripts with RunContext set to Server)"
        )
        .optional(),
      scriptPath: z
        .string()
        .describe("The path to the script to get the content of")
        .optional(),
    }),
  },
  async ({ scriptGetterSource, scriptPath }) => {
    if (scriptGetterSource === undefined && scriptPath === undefined) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: "Must provide either scriptGetterSource or scriptPath.",
          },
        ],
      };
    } else if (scriptGetterSource !== undefined && scriptPath !== undefined) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: "Must provide either scriptGetterSource or scriptPath, not both.",
          },
        ],
      };
    }

    const toolCallId = SendArbitraryDataToClient("get-script-content", {
      source:
        scriptGetterSource === undefined
          ? `return ${scriptPath}`
          : scriptGetterSource,
    });

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
          output: string;
        }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        success: false,
        content: [{ type: "text", text: "Failed to get script content." }],
      };
    }

    return {
      success: true,
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-data-by-code",
  {
    title: "Get data by code",
    description:
      "Query data from the Roblox Game Client by executing code, note that the code MUST return one or more values. IMPORTANT: Do NOT serialize/encode the return value yourself (no HttpService:JSONEncode, no custom table-to-string) - just return raw Lua values directly. The connector automatically serializes all returned data.",

    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "The code to execute in the Roblox Game Client (MUST return one or more values). Return raw Lua values - do NOT manually serialize tables or use JSONEncode, the connector handles serialization automatically."
        ),
      threadContext: z
        .number()
        .describe(
          "The thread identity to execute the code in (default: 8, normal game scripts run on 2)"
        )
        .optional()
        .default(8),
    }),
  },
  async ({ code, threadContext }) => {
    console.error(`Executing code in thread ${threadContext}...`);

    const toolCallId = SendArbitraryDataToClient("get-data-by-code", {
      source: `setthreadidentity(${threadContext});${code}`,
    });

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
          output: string;
        }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to get data by code. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      success: true,
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-console-output",
  {
    title:
      "Get the roblox developer console output from the Roblox Game Client",
    inputSchema: z.object({
      limit: z
        .number()
        .describe(
          "Maximum number of results to return (default: 50, to avoid overwhelming output)"
        )
        .optional()
        .default(50),
      logsOrder: z
        .enum(["NewestFirst", "OldestFirst"])
        .describe("The order of the logs to return (default: NewestFirst)")
        .optional()
        .default("NewestFirst"),
    }),
  },
  async ({ limit, logsOrder }) => {
    const toolCallId = SendArbitraryDataToClient("get-console-output", {
      limit,
      logsOrder,
    });

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
          output: string;
        }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [{ type: "text", text: "Failed to get console output." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "search-instances",
  {
    title: "Search for instances in the game",
    description: `Search for instances in the Roblox game using QueryDescendants with a CSS-like selector syntax. Supports class names (Part), tags (.Tag), names (#Name), properties ([Property = value]), attributes ([$Attribute = value]), combinators (>, >>), and pseudo-classes (:not(), :has()).

SELECTOR SYNTAX:
- ClassName: Matches instances of a class (uses IsA, so 'BasePart' matches Part, MeshPart, etc.). Example: Part, SpotLight, Model
- .Tag: Matches instances with a CollectionService tag. Example: .Fruit, .Enemy, .Interactable
- #Name: Matches instances by their Name property. Example: #HumanoidRootPart, #Head, #Torso
- [Property = value]: Matches instances where a property equals a value (boolean, number, string). Example: [CanCollide = false], [Transparency = 1], [Name = Folder10]
- [$Attribute = value]: Matches instances with a specific attribute value. Example: [$Health = 100], [$IsEnemy = true]
- [$Attribute]: Matches instances that have the attribute set (any value). Example: [$QuestId]

COMBINATORS:
- > : Direct children only. Example: Model > Part (Parts that are direct children of a Model)
- >> : All descendants (default). Example: Model >> Part (Parts anywhere inside a Model)
- , : Multiple selectors (OR). Example: Part, MeshPart (matches either)

PSEUDO-CLASSES:
- :not(selector): Excludes matches. Example: BasePart:not([CanCollide = true]) - parts with CanCollide false
- :has(selector): Matches if containing a descendant. Example: Model:has(> Humanoid) - Models with a Humanoid child

COMBINING SELECTORS: Chain selectors for AND logic. Example: Part.Tagged[Anchored = false] - Parts with tag "Tagged" that are unanchored`,
    inputSchema: z.object({
      selector: z
        .string()
        .describe(
          "The selector string to filter instances (e.g., 'Part', '.Tagged', '#InstanceName', '[CanCollide = false]', 'Model >> Part.Glowing')"
        ),
      root: z
        .string()
        .describe(
          "The root instance to search from (e.g., 'game.Workspace', 'game.ReplicatedStorage'). Defaults to 'game' if not specified."
        )
        .optional()
        .default("game"),
      limit: z
        .number()
        .describe(
          "Maximum number of results to return (default: 50, to avoid overwhelming output)"
        )
        .optional()
        .default(50),
    }),
  },
  async ({ selector, root, limit }) => {
    const toolCallId = SendArbitraryDataToClient("search-instances", {
      selector,
      root,
      limit,
    });

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
          output: string;
        }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to search instances. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "search-scripts-sources",
  {
    title: "Search across all scripts in the game",
    description:
      'Search across all scripts in the game by their source code. IMPORTANT: If a script instance has already been garbage collected, a "<ScriptProxy: DebugId>" string will be returned instead of the script instance path.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The string to search, compatible with Luau string.find() pattern matching. IMPORTANT: using | in the query will be treated as a logical OR, use & for logical AND, and use \\\\\\\\ for escaping (e.g., \\\\\\\\|)."
        ),
      limit: z
        .number()
        .describe(
          "Maximum number of results to return (default: 50, to avoid overwhelming output)"
        )
        .optional()
        .default(50),
      contextLines: z
        .number()
        .describe(
          "Number of lines of context to return before and after the matching line (default: 2)"
        )
        .optional()
        .default(2),
      maxMatchesPerScript: z
        .number()
        .describe(
          "Maximum number of matches to return per script (default: 20)"
        )
        .optional()
        .default(20),
    }),
  },
  async ({ query, limit }) => {
    const toolCallId = SendArbitraryDataToClient("search-scripts-sources", {
      query,
      limit,
    });

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
          output: string;
        }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to search scripts (error occured? Response: " +
              JSON.stringify(response) +
              ")",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-game-info",
  {
    title: "Get information about the current Roblox game",
    description:
      "Retrieves basic information about the current game including PlaceId, GameId, PlaceVersion, and other metadata.",
  },
  async () => {
    const toolCallId = SendArbitraryDataToClient("get-game-info", {});

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
          output: string;
        }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [{ type: "text", text: "Failed to get game info." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
console.error("MCP Server started and connected via stdio.");
