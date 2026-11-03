import QRCode from "qrcode";
import jsQRImport, { type QRCode as JsQrResult } from "jsqr";
import { GitFerryError } from "./errors.js";

// jsqr ships CJS whose module.exports is the function with a self-referential
// `.default` — normalize across node/esbuild interop and give it a callable type.
type JsQrFn = (data: Uint8ClampedArray, width: number, height: number) => JsQrResult | null;
const jsQR = (((jsQRImport as unknown as { default?: unknown }).default ?? jsQRImport) as JsQrFn);

/** A rendered QR symbol: size x size modules, row-major, 1 = dark. */
export interface QrMatrix {
  size: number;
  bits: Uint8Array;
}

export type EccLevel = "L" | "M" | "Q" | "H";

/** Encode raw frame bytes into a QR module matrix (byte mode). */
export function toMatrix(bytes: Uint8Array, ecc: EccLevel = "M", version?: number): QrMatrix {
  try {
    const qr = QRCode.create([{ data: Buffer.from(bytes), mode: "byte" }], {
      errorCorrectionLevel: ecc,
      ...(version ? { version } : {}),
    });
    return { size: qr.modules.size, bits: Uint8Array.from(qr.modules.data) };
  } catch (e) {
    throw new GitFerryError(
      `cannot fit ${bytes.byteLength} bytes into one QR code: ${(e as Error).message}`,
      "lower --chunk",
    );
  }
}

/**
 * Encode every frame at one shared QR version (the largest any frame needs).
 * Uniform size is required for --color channel stacking and looks steadier on screen.
 */
export function toMatricesUniform(frames: Uint8Array[], ecc: EccLevel = "M"): QrMatrix[] {
  let version = 1;
  for (const f of frames) {
    const qr = QRCode.create([{ data: Buffer.from(f), mode: "byte" }], { errorCorrectionLevel: ecc });
    if (qr.version > version) version = qr.version;
  }
  return frames.map((f) => toMatrix(f, ecc, version));
}

/** Pack a matrix's module bits into base64 (MSB-first) for page payloads. */
export function packBits(bits: Uint8Array): string {
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) packed[i >> 3] |= 0x80 >> (i & 7);
  }
  return Buffer.from(packed).toString("base64");
}

/**
 * Rasterize 1-3 equally sized matrices into one RGBA image, one matrix per
 * color channel (R, G, B). A single matrix lands in all channels — a plain
 * black/white QR. Missing channels are left light, so partial groups work.
 */
export function rasterizeGroup(group: QrMatrix[], scale = 4, quiet = 4): { rgba: Uint8ClampedArray; width: number; height: number } {
  if (group.length < 1 || group.length > 3) throw new GitFerryError("a QR group holds 1-3 frames");
  const size = group[0].size;
  if (group.some((m) => m.size !== size)) throw new GitFerryError("grouped QR matrices must share a version");
  const dim = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  const grayscale = group.length === 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const channels = grayscale
        ? group[0].bits[r * size + c]
          ? [0, 0, 0]
          : [255, 255, 255]
        : ([0, 1, 2] as const).map((ch) => (group[ch] && group[ch].bits[r * size + c] ? 0 : 255));
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((r + quiet) * scale + dy) * dim + (c + quiet) * scale + dx;
          rgba[px * 4] = channels[0];
          rgba[px * 4 + 1] = channels[1];
          rgba[px * 4 + 2] = channels[2];
        }
      }
    }
  }
  return { rgba, width: dim, height: dim };
}

/**
 * Decode every gitferry QR frame visible in an RGBA image.
 * Each color channel is decoded separately — that is how --color composites
 * unpack, and a plain B/W code just decodes identically in all three (deduped).
 * A whole-image luminance pass only runs as a fallback: on a color composite it
 * can "succeed" with just the green frame and would mask the other channels.
 */
export function decodeImage(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array[] {
  const seen = new Set<string>();
  const found: Uint8Array[] = [];
  const push = (hit: JsQrResult | null): void => {
    if (!hit || hit.binaryData.length === 0) return;
    const bytes = Uint8Array.from(hit.binaryData);
    const key = Buffer.from(bytes).toString("base64");
    if (seen.has(key)) return;
    seen.add(key);
    found.push(bytes);
  };
  for (const ch of [0, 1, 2]) {
    const gray = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      const v = rgba[i + ch];
      gray[i] = gray[i + 1] = gray[i + 2] = v;
      gray[i + 3] = 255;
    }
    push(jsQR(gray, width, height));
  }
  if (found.length === 0) push(jsQR(rgba, width, height));
  return found;
}
