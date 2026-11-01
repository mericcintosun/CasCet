// Stdio MCP server for gateway tests: its "env" tool returns the names (and
// the value of ALLOWED_VAR) of the environment the process was started with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "env-upstream", version: "1.0.0" });

server.registerTool("env", { description: "Environment variable names of this process" }, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ names: Object.keys(process.env).sort(), allowed: process.env.ALLOWED_VAR ?? null }),
    },
  ],
}));

await server.connect(new StdioServerTransport());
