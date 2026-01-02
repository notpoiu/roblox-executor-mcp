#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebSocketServer, WebSocket } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { z } from "zod";

const WS_PORT = 16384;

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
let httpClientConnected = false;
let pendingHttpCommand: any = null;
let httpResponseResolvers: Map<string, (data: any) => void> = new Map();

// HTTP server for HTTP polling fallback
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${WS_PORT}`);

  // HTTP polling - return pending command if any
  if (url.pathname === "/poll" && req.method === "GET") {
    httpClientConnected = true;

    if (pendingHttpCommand) {
      const cmd = pendingHttpCommand;
      pendingHttpCommand = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cmd));
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

  // HTTP polling client
  return httpClientConnected;
}

const NO_CLIENT_ERROR = {
  content: [
    {
      type: "text" as const,
      text: "No Roblox client connected. Make sure the connector.luau script is running in your Roblox game.",
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
      source: `setthreadidentity(${threadContext})\n${code}`,
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
        content: [{ type: "text", text: "Failed to get data by code." }],
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
  },
  async () => {
    const toolCallId = SendArbitraryDataToClient("get-console-output", {});

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
        content: [{ type: "text", text: "Failed to search instances." }],
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
