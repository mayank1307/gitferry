import { readFileSync } from "node:fs";
import path from "node:path";
import { GitFerryError } from "./errors.js";
import { collectBody, createServer, listenLocal, MAX_IMAGE_BYTES, openBrowser } from "./local.js";
import { decodeImage, type EccLevel, packBits, type QrMatrix, toMatricesUniform } from "./qrcodec.js";
import { type AckInfo, encodeFrames, parseAck, parseFrame } from "./qrwire.js";

export interface ShowPlan {
  fileName: string;
  byteSize: number;
  /** hex id every frame of this transfer carries — acks must match it */
  transferId: string;
  /** wire frames: [header, chunk 1..N] */
  frames: Uint8Array[];
  /** one QR matrix per frame, all at the same version */
  matrices: QrMatrix[];
  /** display groups: indices into frames/matrices. B/W = singles, --color = triples */
  groups: number[][];
  color: boolean;
  dataFrames: number;
}

/** Read a file and lay out its QR frame sequence. */
export function prepareShow(filePath: string, opts: { chunk: number; color: boolean; ecc?: EccLevel }): ShowPlan {
  const data = new Uint8Array(readFileSync(filePath));
  const frames = encodeFrames(data, path.basename(filePath), opts.chunk);
  const matrices = toMatricesUniform(frames, opts.ecc ?? "M");
  // Header stays its own black/white group so any receiver locks on quickly;
  // in color mode the data chunks ride three-per-image in the R/G/B channels.
  const groups: number[][] = [[0]];
  if (opts.color) {
    for (let i = 1; i < frames.length; i += 3) {
      groups.push([i, i + 1, i + 2].filter((j) => j < frames.length));
    }
  } else {
    for (let i = 1; i < frames.length; i++) groups.push([i]);
  }
  return {
    fileName: path.basename(filePath),
    byteSize: data.byteLength,
    transferId: parseFrame(frames[0])!.transferId,
    frames,
    matrices,
    groups,
    color: opts.color,
    dataFrames: frames.length - 1,
  };
}

/** Render one QR matrix as ANSI half-block art (2 module rows per text row). */
export function renderMatrixAnsi(m: QrMatrix, quiet = 4): string {
  const size = m.size + quiet * 2;
  const dark = (r: number, c: number): boolean => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= m.size || cc >= m.size) return false;
    return m.bits[rr * m.size + cc] === 1;
  };
  let out = "";
  for (let r = 0; r < size; r += 2) {
    for (let c = 0; c < size; c++) {
      const fg = dark(r, c) ? "30" : "97";
      const bg = r + 1 < size && dark(r + 1, c) ? "40" : "107";
      out += `\x1b[${fg};${bg}m▀`;
    }
    out += "\x1b[0m\n";
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Loop the QR sequence in the terminal until the user stops it. Never resolves. */
export function runTerminalShow(plan: ShowPlan, fps: number): Promise<never> {
  if (plan.color) {
    throw new GitFerryError("--color needs --browser", "terminals cannot show channel-multiplexed QR codes");
  }
  const quiet = 4;
  const cols = plan.matrices[0].size + quiet * 2;
  const avail = process.stdout.columns ?? 80;
  if (cols > avail) {
    throw new GitFerryError(
      `this QR needs ${cols} columns but the terminal has ${avail}`,
      "lower --chunk, widen the terminal, or use --browser",
    );
  }
  const rendered = plan.matrices.map((m) => renderMatrixAnsi(m, quiet));
  let i = 0;
  let loop = 1;
  process.stdout.write("\x1b[?25l");
  const restore = (): void => {
    process.stdout.write("\x1b[?25h\x1b[0m\n");
    process.exit(0);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
  const tick = (): void => {
    const label =
      i === 0 ? "header frame" : `chunk ${i}/${plan.dataFrames}`;
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(rendered[i]);
    process.stdout.write(
      `\n  ${plan.fileName} · ${formatBytes(plan.byteSize)} · ${label} · loop ${loop} · Ctrl+C to stop\n` +
        `  on the other machine: gitferry read  (point its camera at this window)\n`,
    );
    i = (i + 1) % rendered.length;
    if (i === 0) loop++;
  };
  tick();
  setInterval(tick, Math.round(1000 / fps));
  return new Promise<never>(() => {});
}

/** Serve the QR slideshow as a local web page (bigger, denser, supports --color). */
export async function runBrowserShow(
  plan: ShowPlan,
  opts: { fps: number; retryFps: number; port: number; open: boolean; onAck?: (a: AckInfo) => void },
): Promise<{ url: string; close: () => void; done: Promise<AckInfo> }> {
  const payload = {
    name: plan.fileName,
    size: plan.byteSize,
    sizeLabel: formatBytes(plan.byteSize),
    fps: opts.fps,
    retryFps: opts.retryFps,
    color: plan.color,
    matrixSize: plan.matrices[0].size,
    dataFrames: plan.dataFrames,
    frames: plan.matrices.map((m) => packBits(m.bits)),
    groups: plan.groups,
  };
  const html = SHOW_PAGE.replace("__PAYLOAD__", JSON.stringify(payload).replace(/</g, "\\u003c"));
  // Latest ack seen by this machine's camera. Acks only ever grow (the
  // receiver never un-receives a chunk), so ignore stale camera frames that
  // decode an older code. ackSeen counts every sighting (even identical ones)
  // so the page can tell a *fresh* read during its loop-start scan phase from
  // leftover state captured mid-loop.
  let latestAck: AckInfo | null = null;
  let ackSeen = 0;
  // Resolves the first time this machine's camera reads an ack flagged complete,
  // so the caller can stop the loop and exit instead of spinning forever.
  let resolveDone: (a: AckInfo) => void = () => {};
  const done = new Promise<AckInfo>((r) => {
    resolveDone = r;
  });
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/ack")) {
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
          if (body.byteLength === width * height * 4) {
            for (const bytes of decodeImage(new Uint8ClampedArray(body.buffer, body.byteOffset, body.byteLength), width, height)) {
              const frame = parseFrame(bytes);
              if (frame?.kind !== "ack" || frame.transferId !== plan.transferId) continue;
              const info = parseAck(frame);
              if (!info) continue;
              ackSeen++;
              if (!latestAck || info.received >= latestAck.received) {
                latestAck = info;
                opts.onAck?.(info);
              }
              if (info.complete) resolveDone(info);
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            latestAck
              ? JSON.stringify({
                  hasAck: true,
                  seen: ackSeen,
                  received: latestAck.received,
                  total: latestAck.total,
                  missing: latestAck.missing,
                  missingCount: latestAck.missing.length,
                  headerMissing: latestAck.headerMissing,
                  complete: latestAck.complete,
                })
              : JSON.stringify({ hasAck: false, seen: ackSeen }),
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
  const port = await listenLocal(server, opts.port);
  const url = `http://127.0.0.1:${port}/`;
  if (opts.open) openBrowser(url);
  return {
    url,
    done,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

const SHOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>gitferry show</title>
<style>
  body { margin:0; font:14px system-ui,sans-serif; background:#111; color:#ddd;
         display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px; }
  canvas { background:#fff; image-rendering:pixelated; }
  .bar { display:flex; gap:16px; align-items:center; flex-wrap:wrap; justify-content:center; }
  button { font:inherit; padding:4px 14px; cursor:pointer; }
  .dim { color:#888; } .ok { color:#6c6; }
  #cam { position:fixed; right:12px; bottom:12px; width:180px; border-radius:6px;
         background:#000; opacity:.85; }
</style></head><body>
<div class="bar"><strong id="title"></strong><span class="dim" id="mode"></span></div>
<canvas id="qr"></canvas>
<div class="bar">
  <button id="toggle">pause</button>
  <label>speed <input id="fps" type="range" min="1" max="30" step="1"> <span id="fpsv"></span> fps</label>
  <span id="status" class="dim"></span>
</div>
<div class="dim">on the other machine: <code>gitferry read</code> — point its camera here, keep the code large and steady</div>
<div class="dim" id="camstat"></div>
<video id="cam" autoplay playsinline muted></video>
<script>
const P = __PAYLOAD__;
document.getElementById('title').textContent = P.name + ' · ' + P.sizeLabel;
document.getElementById('mode').textContent = P.color ? 'color (3 chunks per image)' : 'black & white';
const unpack = b64 => { const raw = atob(b64), n = P.matrixSize * P.matrixSize, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1; return out; };
const frames = P.frames.map(unpack);
const quiet = 4, dim = P.matrixSize + quiet * 2;
const imgCache = new Map();
function imageFor(g) {
  const key = g.join(',');
  let img = imgCache.get(key);
  if (img) return img;
  img = new ImageData(dim, dim); img.data.fill(255);
  for (let r = 0; r < P.matrixSize; r++) for (let c = 0; c < P.matrixSize; c++) {
    const px = ((r + quiet) * dim + c + quiet) * 4;
    if (g.length === 1) { const v = frames[g[0]][r * P.matrixSize + c] ? 0 : 255;
      img.data[px] = img.data[px+1] = img.data[px+2] = v; }
    else for (let ch = 0; ch < 3; ch++)
      img.data[px+ch] = (g[ch] !== undefined && frames[g[ch]][r * P.matrixSize + c]) ? 0 : 255;
  }
  imgCache.set(key, img); return img;
}
const allIdx = frames.map((_, ix) => ix);
function buildGroups(idxs) {
  const groups = idxs.includes(0) ? [[0]] : [];
  const rest = idxs.filter(ix => ix !== 0);
  if (P.color) { for (let k = 0; k < rest.length; k += 3) groups.push(rest.slice(k, k + 3)); }
  else for (const ix of rest) groups.push([ix]);
  return groups.length ? groups : [[0]];
}
const off = document.createElement('canvas'); off.width = off.height = dim;
const canvas = document.getElementById('qr'), ctx = canvas.getContext('2d');
const side = Math.floor(Math.min(innerWidth - 40, innerHeight - 190) / dim) * dim || dim;
canvas.width = canvas.height = side; ctx.imageSmoothingEnabled = false;
const status = document.getElementById('status'), camstat = document.getElementById('camstat');
let groupsNow = buildGroups(allIdx);
let i = 0, loop = 1, playing = true, timer = null, finished = false, ack = null, camStream = null;
let scanning = false, scanUntil = 0, scanBaseline = 0, ackSeen = 0;
const label = g => g[0] === 0 ? 'header frame'
  : 'chunk' + (g.length > 1 ? 's' : '') + ' ' + g.join(', ') + ' / ' + P.dataFrames;
function draw() {
  if (finished || scanning) return;
  const g = groupsNow[i];
  off.getContext('2d').putImageData(imageFor(g), 0, 0);
  ctx.drawImage(off, 0, 0, side, side);
  status.textContent = 'image ' + (i + 1) + '/' + groupsNow.length + ' · ' + label(g) + ' · loop ' + loop +
    (ack ? ' · receiver has ' + ack.received + '/' + ack.total : '');
  i++;
  if (i >= groupsNow.length) { i = 0; loop++; startScanPhase(); }
}
// Each new loop starts by READING: pause the slideshow and re-scan the
// receiver's progress code so this loop resends exactly what is missing now.
// A fresh sighting (seen counter advanced) or a 3s timeout ends the pause.
function startScanPhase() {
  if (finished) return;
  if (!camStream) { applyAck(); return; } // no camera on this side: nothing to read
  clearInterval(timer); timer = null;
  scanning = true;
  scanBaseline = ackSeen;
  scanUntil = performance.now() + 3000;
  status.textContent = 'reading the receiver progress code before loop ' + loop + '…';
}
function applyAck() {
  if (ack) {
    if (ack.complete) { finish(); return; }
    const idxs = ack.headerMissing ? [0].concat(ack.missing) : ack.missing.slice();
    groupsNow = buildGroups(idxs.length ? idxs : allIdx);
    setRate(P.retryFps);
  }
  restart();
}
function finish() {
  finished = true; scanning = false; clearInterval(timer);
  status.textContent = '✓ receiver confirmed the whole file — you can close both windows';
  status.className = 'ok';
  camstat.textContent = '';
  if (camStream) camStream.getTracks().forEach(t => t.stop());
}
// The slider is a manual override within its min/max; the true frame rate lives
// in 'rate' so CLI --fps / --retry-fps outside that band (e.g. 0.5) still take
// effect instead of being clamped to whole steps by the input element.
const fpsIn = document.getElementById('fps'); let rate = P.fps;
function reflectRate() {
  fpsIn.value = Math.min(+fpsIn.max, Math.max(+fpsIn.min, Math.round(rate)));
  document.getElementById('fpsv').textContent = rate;
}
function restart() { clearInterval(timer); reflectRate();
  if (playing && !finished && !scanning) timer = setInterval(draw, 1000 / rate); }
function setRate(n) { rate = +n; }
fpsIn.oninput = () => { rate = +fpsIn.value; restart(); };
document.getElementById('toggle').onclick = e => { playing = !playing;
  e.target.textContent = playing ? 'pause' : 'play'; restart(); };
draw(); restart();
// This machine's camera watches the receiver page for its progress QR and
// reports it to the CLI. Polls fast during a loop-start scan phase, lazily
// while the slideshow runs (still catches "complete" early).
async function watchAcks() {
  const camVideo = document.getElementById('cam');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    camstat.textContent = 'no camera on this side (' + e.message + ') — re-showing every chunk each loop';
    camVideo.remove(); return;
  }
  camVideo.srcObject = camStream;
  await new Promise(r => camVideo.onloadedmetadata = r);
  const work = document.createElement('canvas');
  const scale = Math.min(1, 800 / camVideo.videoWidth);
  work.width = Math.round(camVideo.videoWidth * scale);
  work.height = Math.round(camVideo.videoHeight * scale);
  const wctx = work.getContext('2d', { willReadFrequently: true });
  camstat.textContent = 'camera on: reads the receiver progress code at each loop start (bottom-right preview)';
  while (!finished) {
    const t0 = performance.now();
    wctx.drawImage(camVideo, 0, 0, work.width, work.height);
    const img = wctx.getImageData(0, 0, work.width, work.height);
    try {
      const r = await fetch('/ack?w=' + work.width + '&h=' + work.height,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: img.data.buffer });
      if (r.ok) {
        const s = await r.json();
        if (s.seen !== undefined) ackSeen = s.seen;
        if (s.hasAck) {
          ack = s;
          if (s.complete) { finish(); break; }
          camstat.textContent = 'receiver has ' + s.received + '/' + s.total +
            (s.missingCount ? ' — next loop resends ' + s.missingCount + ' missing at ' + P.retryFps + ' fps' : '');
        }
      }
    } catch (e) { /* CLI stopped; keep showing the loop */ }
    if (scanning && (ackSeen > scanBaseline || performance.now() > scanUntil)) {
      scanning = false;
      applyAck();
    }
    await new Promise(r2 => setTimeout(r2, Math.max(0, (scanning ? 200 : 500) - (performance.now() - t0))));
  }
}
watchAcks();
</script></body></html>`;
