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
const PROMOTION_JITTER_MAX = 300; // ms

// ─── Instance role ──────────────────────────────────────────────────────────────
let instanceRole: "primary" | "secondary" = "primary";

// ─── Primary-mode state ─────────────────────────────────────────────────────────
let httpServer: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;

// HTTP polling state (primary only)
let lastHttpPollTime = 0;
let pendingHttpCommand: any = null;
let httpResponseResolvers: Map<string, (data: any) => void> = new Map();

// Relay clients (secondaries connected to this primary)
let relayClients: Set<WebSocket> = new Set();
// Map request id → relay WebSocket that sent it, so responses route back
let relayRequestOrigin: Map<string, WebSocket> = new Map();

// ─── Secondary-mode state ───────────────────────────────────────────────────────
let relaySocket: WebSocket | null = null;
let secondaryResponseResolvers: Map<string, (data: any) => void> = new Map();

// ─── Status page HTML ───────────────────────────────────────────────────────────
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
                <div class="stat-item">
                    <div class="stat-label">Role</div>
                    <div class="stat-value" id="roleValue">—</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Relay Clients</div>
                    <div class="stat-value" id="relayCount">0</div>
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
        const roleValue = document.getElementById('roleValue');
        const relayCountValue = document.getElementById('relayCount');

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
                roleValue.innerText = data.role;
                relayCountValue.innerText = data.relayClients;
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

// ─── MCP Server (always created regardless of role) ─────────────────────────────
const server = new McpServer({
  name: "RobloxMCP",
  version: "1.0.0",
  description:
    "A MCP Server allowing interaction to the Roblox Game Client (including access to restricted APIs such as getgc(), getreg(), etc.) with full control over the game.",
});

const NO_CLIENT_ERROR = {
  content: [
    {
      type: "text" as const,
      text: "No Roblox client connected to the MCP server. Please notify the user that they have to run the connector.luau script in order to connect the MCP server to their game.",
    },
  ],
};

// ─── Abstraction layer — these work in both primary & secondary mode ────────────

function hasConnectedClients(): boolean {
  if (instanceRole === "secondary") {
    return relaySocket !== null && relaySocket.readyState === WebSocket.OPEN;
  }

  // Primary: check for Roblox WS clients (exclude relay clients)
  if (wss) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && !relayClients.has(client)) {
        return true;
      }
    }
  }

  // HTTP polling client
  return Date.now() - lastHttpPollTime < HTTP_POLL_TIMEOUT;
}

function SendToClients(message: string) {
  if (instanceRole === "secondary") {
    // Forward through relay socket
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
      relaySocket.send(message);
    }
    return;
  }

  // Primary: send to Roblox WS clients (not relay clients)
  let hasWsClient = false;
  if (wss) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && !relayClients.has(client)) {
        hasWsClient = true;
        client.send(message);
      }
    });
  }

  // Queue for HTTP polling
  if (!hasWsClient) {
    pendingHttpCommand = message;
  }
}

function GetResponseOfIdFromClient(id: string): Promise<any> {
  return new Promise((resolve) => {
    if (instanceRole === "secondary") {
      // Wait for response on relay socket
      secondaryResponseResolvers.set(id, resolve);
      return;
    }

    // Primary: responses arrive via wss on("message") → handleRobloxResponse()
    // or via HTTP /respond endpoint — both resolve through httpResponseResolvers.
    httpResponseResolvers.set(id, resolve);
  });
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

// ─── Primary mode ───────────────────────────────────────────────────────────────

function startAsPrimary(): Promise<void> {
  return new Promise((resolve, reject) => {
    instanceRole = "primary";

    // Reset primary state
    lastHttpPollTime = 0;
    pendingHttpCommand = null;
    httpResponseResolvers = new Map();
    relayClients = new Set();
    relayRequestOrigin = new Map();

    httpServer = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || "/", `http://localhost:${WS_PORT}`);

        // Root status page
        if (url.pathname === "/" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(STATUS_PAGE_HTML);
          return;
        }

        // API Status for dashboard polling
        if (url.pathname === "/api/status" && req.method === "GET") {
          const wsClients = wss
            ? Array.from(wss.clients).filter(
                (c) =>
                  c.readyState === WebSocket.OPEN && !relayClients.has(c)
              ).length
            : 0;
          const isHttpConnected =
            Date.now() - lastHttpPollTime < HTTP_POLL_TIMEOUT;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              connected: wsClients > 0 || isHttpConnected,
              method:
                wsClients > 0
                  ? "WebSocket"
                  : isHttpConnected
                    ? "HTTP"
                    : "None",
              clientCount: wsClients + (isHttpConnected ? 1 : 0),
              role: "Primary",
              relayClients: relayClients.size,
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
              handleRobloxResponse(data);
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
      }
    );

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(err);
      } else {
        console.error("[Primary] HTTP server error:", err);
        reject(err);
      }
    });

    httpServer.listen(WS_PORT, () => {
      console.error(
        `[Primary] MCP Bridge listening on port ${WS_PORT} (WebSocket + HTTP)`
      );

      // Create WSS only after listen succeeds to avoid unhandled error propagation
      wss = new WebSocketServer({ server: httpServer! });

      wss.on("connection", (ws, req) => {
        const urlPath = req.url || "/";

        if (urlPath === "/mcp-relay") {
          // ── Secondary MCP instance connecting as relay ──
          console.error(`[Primary] Relay client connected. Total: ${relayClients.size + 1}`);
          relayClients.add(ws);

          ws.on("message", (rawData) => {
            try {
              const message = JSON.parse(rawData.toString());

              // This is a tool-call request from a secondary, forward to Roblox
              if (message.id) {
                relayRequestOrigin.set(message.id, ws);
              }

              // Forward to actual Roblox clients
              let sentToRoblox = false;
              wss!.clients.forEach((client) => {
                if (
                  client.readyState === WebSocket.OPEN &&
                  !relayClients.has(client)
                ) {
                  sentToRoblox = true;
                  client.send(rawData.toString());
                }
              });

              // Fallback to HTTP polling queue
              if (!sentToRoblox) {
                pendingHttpCommand = rawData.toString();
              }
            } catch (e) {
              console.error("[Primary] Error parsing relay message:", e);
            }
          });

          ws.on("close", () => {
            relayClients.delete(ws);
            console.error(`[Primary] Relay client disconnected. Total: ${relayClients.size}`);
            // Clean up any pending request origins for this client
            for (const [id, origin] of relayRequestOrigin.entries()) {
              if (origin === ws) {
                relayRequestOrigin.delete(id);
              }
            }
          });

          ws.on("error", (err) => {
            console.error("[Primary] Relay client error:", err.message);
            relayClients.delete(ws);
          });

          return;
        }

        // ── Regular Roblox game client ──
        console.error("[Primary] Roblox client connected via WebSocket.");

        ws.on("message", (rawData) => {
          try {
            const data = JSON.parse(rawData.toString());
            handleRobloxResponse(data);
          } catch (e) {
            console.error("[Primary] Error parsing Roblox WS message:", e);
          }
        });

        ws.on("close", () => {
          console.error("[Primary] Roblox client disconnected.");
        });
      });

      resolve();
    });
  });
}

/**
 * Route a response from a Roblox client.
 * If the request originated from a relay secondary, forward it back.
 * Otherwise resolve the local promise.
 */
function handleRobloxResponse(data: any) {
  if (!data.id) return;

  // Check if this response belongs to a relayed secondary request
  const originRelay = relayRequestOrigin.get(data.id);
  if (originRelay && originRelay.readyState === WebSocket.OPEN) {
    originRelay.send(JSON.stringify(data));
    relayRequestOrigin.delete(data.id);
    return;
  }
  relayRequestOrigin.delete(data.id);

  // Otherwise it's a local primary request
  if (httpResponseResolvers.has(data.id)) {
    httpResponseResolvers.get(data.id)?.(data);
    httpResponseResolvers.delete(data.id);
  }
}

// ─── Secondary mode ─────────────────────────────────────────────────────────────

function startAsSecondary(): void {
  instanceRole = "secondary";
  secondaryResponseResolvers = new Map();

  console.error(
    `[Secondary] Port ${WS_PORT} in use. Connecting to primary via relay...`
  );

  relaySocket = new WebSocket(`ws://localhost:${WS_PORT}/mcp-relay`);

  relaySocket.on("open", () => {
    console.error("[Secondary] Connected to primary via /mcp-relay.");
  });

  relaySocket.on("message", (rawData) => {
    try {
      const data = JSON.parse(rawData.toString());
      if (data.id && secondaryResponseResolvers.has(data.id)) {
        secondaryResponseResolvers.get(data.id)!(data);
        secondaryResponseResolvers.delete(data.id);
      }
    } catch (e) {
      console.error("[Secondary] Error parsing relay response:", e);
    }
  });

  relaySocket.on("close", () => {
    console.error("[Secondary] Lost connection to primary. Attempting promotion...");
    relaySocket = null;
    // Reject all pending resolvers so tool calls don't hang forever
    for (const [id, resolver] of secondaryResponseResolvers.entries()) {
      resolver({ id, output: undefined });
    }
    secondaryResponseResolvers.clear();
    tryPromote();
  });

  relaySocket.on("error", (err) => {
    console.error("[Secondary] Relay socket error:", err.message);
  });
}

// ─── Promotion / Boot ───────────────────────────────────────────────────────────

function tryPromote() {
  // Random jitter to avoid multiple secondaries racing
  const jitter = Math.floor(Math.random() * PROMOTION_JITTER_MAX);
  console.error(`[Promote] Waiting ${jitter}ms before attempting promotion...`);

  setTimeout(async () => {
    try {
      await startAsPrimary();
      console.error("[Promote] Successfully promoted to primary!");
    } catch {
      console.error(
        "[Promote] Another instance already claimed primary. Reconnecting as secondary..."
      );
      // Small delay before reconnecting to let the new primary fully start
      setTimeout(() => startAsSecondary(), 200);
    }
  }, jitter);
}

async function boot() {
  try {
    await startAsPrimary();
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      startAsSecondary();
    } else {
      console.error("[Boot] Fatal error:", err);
      process.exit(1);
    }
  }
}

// ─── Tool registrations (work in both primary & secondary mode) ─────────────────

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

// ─── Start everything ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
console.error("MCP Server started and connected via stdio.");

boot();
