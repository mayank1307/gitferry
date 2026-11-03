#!/usr/bin/env node
/** Process entry point shared by gitferry-mcp and `gitferry mcp`. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGitFerryServer } from "./mcp/server.js";

const server = createGitFerryServer();

// No top-level await: keeps the standalone CommonJS bundle valid.
server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error(`gitferry-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
