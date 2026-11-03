import { spawn } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { GitFerryError } from "./errors.js";

/** Best-effort: open a URL in the default browser; printing the URL is the real UX. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

/** Bind an http server on 127.0.0.1 and resolve with its actual port. */
export function listenLocal(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (e) => reject(new GitFerryError(`cannot start local server: ${e.message}`)));
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new GitFerryError("cannot determine local server port"));
        return;
      }
      resolve(addr.port);
    });
  });
}

/** Camera pages POST raw RGBA frames; cap them so a bad client cannot balloon memory. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Buffer a request body up to `limit` bytes (small slack for chunk framing). */
export function collectBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      len += c.byteLength;
      if (len > limit + 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** QR pages are local-only: reject DNS rebinding and requests from other sites. */
export function createServer(listener: RequestListener): Server {
  return createHttpServer((req, res) => {
    const port = req.socket.localPort;
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = req.headers.origin;
    if (!host || !allowedHosts.includes(host) || (origin !== undefined && origin !== `http://${host}`)) {
      res.writeHead(403, { "content-type": "text/plain", "connection": "close" });
      res.end("Local requests only");
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    listener(req, res);
  });
}
