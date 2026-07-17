import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
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

export { createServer };
