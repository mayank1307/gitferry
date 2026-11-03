import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, listenLocal } from "../src/core/local.js";

describe("QR loopback HTTP boundary", () => {
  const server = createServer((_req, res) => res.end("local page"));
  let port: number;
  beforeAll(async () => { port = await listenLocal(server, 0); });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  function get(headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("serves the local page and its same-origin camera requests", async () => {
    expect(await get()).toEqual({ status: 200, body: "local page" });
    expect((await get({ Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it("rejects a rebound Host header before serving bundle data", async () => {
    expect((await get({ Host: `attacker.example:${port}` })).status).toBe(403);
    expect((await get({ Host: "127.0.0.1:1" })).status).toBe(403);
  });

  it("rejects browser requests from other origins and opaque origins", async () => {
    expect((await get({ Origin: "https://attacker.example" })).status).toBe(403);
    expect((await get({ Origin: "null" })).status).toBe(403);
  });
});
