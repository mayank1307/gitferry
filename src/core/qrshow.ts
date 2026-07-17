import { readFileSync } from "node:fs";
import path from "node:path";
import { GitFerryError } from "./errors.js";
import { createServer, listenLocal, openBrowser } from "./local.js";
import { type EccLevel, type QrMatrix, toMatricesUniform } from "./qrcodec.js";
import { encodeFrames } from "./qrwire.js";

export interface ShowPlan {
  fileName: string;
  byteSize: number;
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
  opts: { fps: number; port: number; open: boolean },
): Promise<{ url: string }> {
  const payload = {
    name: plan.fileName,
    size: plan.byteSize,
    sizeLabel: formatBytes(plan.byteSize),
    fps: opts.fps,
    color: plan.color,
    matrixSize: plan.matrices[0].size,
    dataFrames: plan.dataFrames,
    frames: plan.matrices.map((m) => packBits(m.bits)),
    groups: plan.groups,
  };
  const html = SHOW_PAGE.replace("__PAYLOAD__", JSON.stringify(payload).replace(/</g, "\\u003c"));
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const port = await listenLocal(server, opts.port);
  const url = `http://127.0.0.1:${port}/`;
  if (opts.open) openBrowser(url);
  return { url };
}

function packBits(bits: Uint8Array): string {
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) packed[i >> 3] |= 0x80 >> (i & 7);
  }
  return Buffer.from(packed).toString("base64");
}

const SHOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>gitferry show</title>
<style>
  body { margin:0; font:14px system-ui,sans-serif; background:#111; color:#ddd;
         display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px; }
  canvas { background:#fff; image-rendering:pixelated; }
  .bar { display:flex; gap:16px; align-items:center; flex-wrap:wrap; justify-content:center; }
  button { font:inherit; padding:4px 14px; cursor:pointer; }
  .dim { color:#888; }
</style></head><body>
<div class="bar"><strong id="title"></strong><span class="dim" id="mode"></span></div>
<canvas id="qr"></canvas>
<div class="bar">
  <button id="toggle">pause</button>
  <label>speed <input id="fps" type="range" min="1" max="15" step="1"> <span id="fpsv"></span> fps</label>
  <span id="status" class="dim"></span>
</div>
<div class="dim">on the other machine: <code>gitferry read</code> — point its camera here, keep the code large and steady</div>
<script>
const P = __PAYLOAD__;
document.getElementById('title').textContent = P.name + ' · ' + P.sizeLabel;
document.getElementById('mode').textContent = P.color ? 'color (3 chunks per image)' : 'black & white';
const unpack = b64 => { const raw = atob(b64), n = P.matrixSize * P.matrixSize, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1; return out; };
const frames = P.frames.map(unpack);
const quiet = 4, dim = P.matrixSize + quiet * 2;
const groupImages = P.groups.map(g => {
  const img = new ImageData(dim, dim); img.data.fill(255);
  for (let r = 0; r < P.matrixSize; r++) for (let c = 0; c < P.matrixSize; c++) {
    const px = ((r + quiet) * dim + c + quiet) * 4;
    if (g.length === 1) { const v = frames[g[0]][r * P.matrixSize + c] ? 0 : 255;
      img.data[px] = img.data[px+1] = img.data[px+2] = v; }
    else for (let ch = 0; ch < 3; ch++)
      img.data[px+ch] = (g[ch] !== undefined && frames[g[ch]][r * P.matrixSize + c]) ? 0 : 255;
  }
  return img;
});
const off = document.createElement('canvas'); off.width = off.height = dim;
const canvas = document.getElementById('qr'), ctx = canvas.getContext('2d');
const side = Math.floor(Math.min(innerWidth - 40, innerHeight - 170) / dim) * dim || dim;
canvas.width = canvas.height = side; ctx.imageSmoothingEnabled = false;
let i = 0, loop = 1, playing = true, timer = null;
const label = g => g[0] === 0 ? 'header frame'
  : 'chunk' + (g.length > 1 ? 's' : '') + ' ' + g.join(', ') + ' / ' + P.dataFrames;
function draw() {
  off.getContext('2d').putImageData(groupImages[i], 0, 0);
  ctx.drawImage(off, 0, 0, side, side);
  document.getElementById('status').textContent =
    'image ' + (i + 1) + '/' + P.groups.length + ' · ' + label(P.groups[i]) + ' · loop ' + loop;
  i = (i + 1) % P.groups.length; if (i === 0) loop++;
}
const fpsIn = document.getElementById('fps'); fpsIn.value = P.fps;
function restart() { clearInterval(timer); document.getElementById('fpsv').textContent = fpsIn.value;
  if (playing) timer = setInterval(draw, 1000 / +fpsIn.value); }
fpsIn.oninput = restart;
document.getElementById('toggle').onclick = e => { playing = !playing;
  e.target.textContent = playing ? 'pause' : 'play'; restart(); };
draw(); restart();
</script></body></html>`;
