import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createGitFerryServer } from "../src/mcp/server.js";

it("creates independent MCP sessions and keeps the second usable when the first closes", async () => {
  const sessions = [0, 1].map(() => {
    const server = createGitFerryServer();
    const client = new Client({ name: "factory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    return { server, client, clientTransport, serverTransport };
  });
  try {
    for (const session of sessions) {
      await session.server.connect(session.serverTransport);
      await session.client.connect(session.clientTransport);
      expect((await session.client.listTools()).tools.map((tool) => tool.name).sort())
        .toEqual(["apply_bundle", "inspect_bundle", "pack_changes"]);
    }
    await sessions[0].client.close();
    await sessions[0].server.close();
    expect((await sessions[1].client.listTools()).tools).toHaveLength(3);
  } finally {
    for (const session of sessions) {
      await session.client.close();
      await session.server.close();
    }
  }
});
