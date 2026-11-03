import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GitFerryError } from "./errors.js";
import { collectBody, createServer, listenLocal, MAX_IMAGE_BYTES, openBrowser } from "./local.js";
import { decodeImage, packBits, toMatrix } from "./qrcodec.js";
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

/**
 * Receive a QR transfer: serve a local page that streams webcam frames here,
 * decode them, and resolve once every numbered chunk arrived and sha256 checks out.
 */
export function runRead(opts: ReadOptions): Promise<ReadResult> {
  const cwd = opts.cwd ?? process.cwd();
  const assembler = new Assembler();
  let done = false;
  let finishing = false;

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
      if (!p.complete || done || finishing) return;
      // Reserve the finish so a second frame cannot re-enter, but don't announce
      // `done` until the bytes are actually verified and written — otherwise the
      // page and the sender's ack would report success for a file that failed its
      // sha256 check.
      finishing = true;
      try {
        const { name, data } = assembler.assemble();
        const outputPath = path.resolve(cwd, opts.output ?? path.basename(name));
        if (existsSync(outputPath) && !opts.force) {
          throw new GitFerryError(`refusing to overwrite ${outputPath}`, "pass --force or -o <other-file>");
        }
        writeFileSync(outputPath, data);
        done = true;
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

    // Back-channel QR shown on this page for the sender's camera: what already
    // arrived, so the sender re-loops only the rest. High ECC + tiny payload
    // keep it low-version and easy to scan. Cached — it only changes when a
    // new frame actually lands.
    let ackKey = "";
    let ackQr: { size: number; bits: string } | null = null;
    const currentAck = (p: AssembleProgress): { size: number; bits: string } | null => {
      const key = `${p.received}/${p.total}/${p.headerMissing}`;
      if (key !== ackKey) {
        ackKey = key;
        const bytes = assembler.ackFrame();
        if (bytes) {
          try {
            const m = toMatrix(bytes, "Q");
            ackQr = { size: m.size, bits: packBits(m.bits) };
          } catch {
            // too many frames to fit one easy-scan code — drop the back-channel
            // rather than 400 the whole transfer; the sender re-loops everything.
            ackQr = null;
          }
        } else {
          ackQr = null;
        }
      }
      return ackQr;
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
                ack: currentAck(p),
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

const READ_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>gitferry read</title>
<style>
  body { margin:0; font:15px system-ui,sans-serif; background:#111; color:#ddd;
         display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px; }
  video { max-width:min(34vw,420px); border-radius:6px; background:#000; }
  .row { display:flex; gap:24px; align-items:center; justify-content:center; flex-wrap:wrap; }
  .ackbox { display:none; flex-direction:column; align-items:center; gap:6px; text-align:center; }
  #ack { background:#fff; image-rendering:pixelated; }
  #status { font-size:20px; }
  .ok { color:#6c6; } .warn { color:#fc6; } .dim { color:#888; }
  progress { width:min(90vw,640px); height:10px; }
</style></head><body>
<h3 style="margin:0">gitferry read — point this camera at the sender's QR window</h3>
<div class="row">
  <div class="ackbox" id="ackbox">
    <canvas id="ack"></canvas>
    <span class="dim">progress code — keep it big and visible to the <em>sender's</em> camera; it re-loops only what is missing</span>
  </div>
  <video id="v" autoplay playsinline muted></video>
</div>
<progress id="bar" value="0" max="1"></progress>
<div id="status">waiting for camera…</div>
<div id="detail" class="dim"></div>
<script>
const status = document.getElementById('status'), detail = document.getElementById('detail'),
      bar = document.getElementById('bar'), video = document.getElementById('v'),
      ackbox = document.getElementById('ackbox'), ackCanvas = document.getElementById('ack');
const work = document.createElement('canvas');
let ackDrawn = '', lastAck = null;
function drawAck(ack) {
  if (!ack) return;
  lastAck = ack;
  const quiet = 4, dim = ack.size + quiet * 2;
  // As big as the viewport comfortably allows — this code is what the sender's
  // camera must read across the gap, so it outranks everything else on screen.
  const scale = Math.max(6, Math.floor(Math.min(innerWidth * 0.52, innerHeight * 0.62) / dim));
  const key = ack.size + ':' + ack.bits + ':' + scale;
  if (key === ackDrawn) return;
  ackDrawn = key;
  const raw = atob(ack.bits);
  ackCanvas.width = ackCanvas.height = dim * scale;
  const c = ackCanvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, ackCanvas.width, ackCanvas.height);
  c.fillStyle = '#000';
  for (let i = 0; i < ack.size * ack.size; i++) {
    if ((raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1)
      c.fillRect(((i % ack.size) + quiet) * scale, (Math.floor(i / ack.size) + quiet) * scale, scale, scale);
  }
  ackbox.style.display = 'flex';
}
addEventListener('resize', () => drawAck(lastAck));
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
    drawAck(s.ack);
    if (s.done) {
      status.textContent = '✓ complete — ' + (s.name || 'file') + ' written. See the terminal.';
      status.className = 'ok'; bar.value = 1;
      detail.textContent = 'leave the progress code on screen a moment so the sender sees "complete" and stops.';
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
