import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { GitFerryError } from "./errors.js";
import { createServer, listenLocal, openBrowser } from "./local.js";
import { decodeImage } from "./qrcodec.js";
import { Assembler, type AssembleProgress, parseFrame } from "./qrwire.js";

export interface ReadOptions {
  /** where to write the file (default: sender's filename in cwd) */
  output?: string;
  cwd?: string;
  port: number;
  open: boolean;
  /** overwrite an existing output file */
  force: boolean;
  onProgress?: (p: AssembleProgress) => void;
  onListen?: (url: string) => void;
}

export interface ReadResult {
  outputPath: string;
  name: string;
  bytes: number;
  url: string;
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Receive a QR transfer: serve a local page that streams webcam frames here,
 * decode them, and resolve once every numbered chunk arrived and sha256 checks out.
 */
export function runRead(opts: ReadOptions): Promise<ReadResult> {
  const cwd = opts.cwd ?? process.cwd();
  const assembler = new Assembler();
  let done = false;

  return new Promise<ReadResult>((resolve, reject) => {
    if (opts.output) {
      const target = path.resolve(cwd, opts.output);
      if (existsSync(target) && !opts.force) {
        reject(new GitFerryError(`refusing to overwrite ${target}`, "pass --force or -o <other-file>"));
        return;
      }
    }
    const finishIfComplete = (): void => {
      const p = assembler.progress();
      opts.onProgress?.(p);
      if (!p.complete || done) return;
      done = true;
      try {
        const { name, data } = assembler.assemble();
        const outputPath = path.resolve(cwd, opts.output ?? path.basename(name));
        if (existsSync(outputPath) && !opts.force) {
          throw new GitFerryError(`refusing to overwrite ${outputPath}`, "pass --force or -o <other-file>");
        }
        writeFileSync(outputPath, data);
        // let the final /frame response reach the page before tearing down
        setTimeout(() => {
          server.close();
          server.closeAllConnections?.();
          resolve({ outputPath, name, bytes: data.byteLength, url });
        }, 300);
      } catch (e) {
        server.close();
        server.closeAllConnections?.();
        reject(e);
      }
    };

    const server = createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(READ_PAGE);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/frame")) {
        const q = new URL(req.url, "http://localhost").searchParams;
        const width = Number(q.get("w"));
        const height = Number(q.get("h"));
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width * height * 4 > MAX_IMAGE_BYTES) {
          res.writeHead(400);
          res.end();
          return;
        }
        collectBody(req, width * height * 4)
          .then((body) => {
            if (body.byteLength === width * height * 4 && !done) {
              for (const bytes of decodeImage(new Uint8ClampedArray(body.buffer, body.byteOffset, body.byteLength), width, height)) {
                const frame = parseFrame(bytes);
                if (frame) assembler.add(frame);
              }
              finishIfComplete();
            }
            const p = assembler.progress();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                received: p.received,
                total: p.total,
                missing: p.missing.slice(0, 30),
                missingCount: p.missing.length,
                headerMissing: p.headerMissing,
                name: p.header?.name ?? null,
                foreign: p.foreignFrames,
                done,
              }),
            );
          })
          .catch(() => {
            res.writeHead(400);
            res.end();
          });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let url = "";
    listenLocal(server, opts.port)
      .then((port) => {
        url = `http://127.0.0.1:${port}/`;
        opts.onListen?.(url);
        opts.onProgress?.(assembler.progress());
        if (opts.open) openBrowser(url);
      })
      .catch(reject);
  });
}

function collectBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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

const READ_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>gitferry read</title>
<style>
  body { margin:0; font:15px system-ui,sans-serif; background:#111; color:#ddd;
         display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px; }
  video { max-width:min(90vw,640px); border-radius:6px; background:#000; }
  #status { font-size:20px; }
  .ok { color:#6c6; } .warn { color:#fc6; } .dim { color:#888; }
  progress { width:min(90vw,640px); height:10px; }
</style></head><body>
<h3 style="margin:0">gitferry read — point this camera at the sender's QR window</h3>
<video id="v" autoplay playsinline muted></video>
<progress id="bar" value="0" max="1"></progress>
<div id="status">waiting for camera…</div>
<div id="detail" class="dim"></div>
<script>
const status = document.getElementById('status'), detail = document.getElementById('detail'),
      bar = document.getElementById('bar'), video = document.getElementById('v');
const work = document.createElement('canvas');
async function main() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' } });
  } catch (e) { status.textContent = 'camera unavailable: ' + e.message; status.className = 'warn'; return; }
  video.srcObject = stream;
  await new Promise(r => video.onloadedmetadata = r);
  const scale = Math.min(1, 800 / video.videoWidth);
  work.width = Math.round(video.videoWidth * scale);
  work.height = Math.round(video.videoHeight * scale);
  const ctx = work.getContext('2d', { willReadFrequently: true });
  status.textContent = 'scanning…';
  while (true) {
    const t0 = performance.now();
    ctx.drawImage(video, 0, 0, work.width, work.height);
    const img = ctx.getImageData(0, 0, work.width, work.height);
    let s;
    try {
      const r = await fetch('/frame?w=' + work.width + '&h=' + work.height,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: img.data.buffer });
      if (!r.ok) throw new Error('server ' + r.status);
      s = await r.json();
    } catch (e) {
      status.textContent = 'receiver stopped (' + e.message + ')'; status.className = 'warn'; break;
    }
    if (s.done) {
      status.textContent = '✓ complete — ' + (s.name || 'file') + ' written. See the terminal.';
      status.className = 'ok'; bar.value = 1;
      stream.getTracks().forEach(t => t.stop());
      break;
    }
    if (s.total > 0) {
      bar.max = s.total + 1; bar.value = s.received + (s.headerMissing ? 0 : 1);
      status.textContent = 'received ' + s.received + '/' + s.total + ' chunks' +
        (s.headerMissing ? ' (header pending)' : ' of ' + s.name);
      detail.textContent = s.missingCount
        ? 'missing: ' + s.missing.join(', ') + (s.missingCount > s.missing.length ? ' …' : '') +
          ' — keep the camera on the loop, they will come around again'
        : '';
      if (s.foreign > 0) detail.textContent += '  ⚠ frames from a different transfer are also visible';
    }
    await new Promise(r => setTimeout(r, Math.max(0, 140 - (performance.now() - t0))));
  }
}
main();
</script></body></html>`;
