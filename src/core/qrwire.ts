import { createHash } from "node:crypto";
import { GitFerryError } from "./errors.js";

/**
 * Wire format for QR transfer. Every QR frame carries a fixed 12-byte header
 * so the receiver always knows which piece it is looking at and how many exist:
 *
 *   bytes 0-2   magic "GFQ"
 *   byte  3     kind: 0 = header frame, 1 = data frame, 2 = ack frame
 *   bytes 4-7   transferId: first 4 bytes of the file's sha256
 *   bytes 8-9   index (uint16 BE): 0 for the header frame, 1..total for data,
 *               received-count for an ack
 *   bytes 10-11 total (uint16 BE): number of data frames in this transfer
 *   bytes 12..  payload
 *
 * The header frame's payload is JSON metadata (name, size, sha256, chunk size),
 * so completeness is provable: all indices 1..total received + sha256 matches.
 *
 * The ack frame travels the OTHER way: the receiver renders it as its own QR so
 * the sender's camera can see what already arrived and re-loop only the rest.
 * Its payload is 1 flags byte (bit0 = header received, bit1 = complete) followed
 * by a received-bitmap: bit (i-1) set = data frame i received, MSB-first.
 */

export const FRAME_OVERHEAD = 12;
/** QR version 40 @ L holds 2953 bytes; leave headroom for the frame header. */
export const MAX_CHUNK = 2900;
export const MAX_FRAMES = 65535;
/**
 * The ack QR is rendered at ECC "Q", whose version-40 byte capacity is 1663.
 * An ack frame larger than this cannot be drawn as a single code, so `ackFrame`
 * returns null past it and the sender falls back to re-looping every chunk.
 */
export const MAX_ACK_FRAME_BYTES = 1663;

const MAGIC = [0x47, 0x46, 0x51]; // "GFQ"
const KIND_HEADER = 0;
const KIND_DATA = 1;
const KIND_ACK = 2;
const ACK_FLAG_HEADER = 1;
const ACK_FLAG_COMPLETE = 2;

export interface TransferHeader {
  v: 1;
  /** suggested output filename */
  name: string;
  /** total payload size in bytes */
  size: number;
  /** sha256 hex of the complete payload */
  sha256: string;
  /** data payload bytes per frame (last frame may be shorter) */
  chunk: number;
  /** number of data frames */
  total: number;
}

export interface Frame {
  kind: "header" | "data" | "ack";
  /** hex of the 4 transferId bytes */
  transferId: string;
  index: number;
  total: number;
  payload: Uint8Array;
}

/** What a receiver's ack QR told the sender. */
export interface AckInfo {
  transferId: string;
  total: number;
  received: number;
  /** data frame indices (1-based) the receiver still needs */
  missing: number[];
  headerMissing: boolean;
  complete: boolean;
}

/** Split a payload into QR frame byte strings: [header, data 1, ..., data N]. */
export function encodeFrames(data: Uint8Array, name: string, chunkSize: number): Uint8Array[] {
  if (chunkSize < 16 || chunkSize > MAX_CHUNK) {
    throw new GitFerryError(`chunk size must be between 16 and ${MAX_CHUNK} bytes`);
  }
  if (data.byteLength === 0) throw new GitFerryError("nothing to send: file is empty");
  const total = Math.ceil(data.byteLength / chunkSize);
  if (total > MAX_FRAMES) {
    throw new GitFerryError(
      `file needs ${total} frames but the format tops out at ${MAX_FRAMES}`,
      "raise --chunk or send a smaller file",
    );
  }
  const sha256 = createHash("sha256").update(data).digest();
  const transferId = sha256.subarray(0, 4);
  const header: TransferHeader = {
    v: 1,
    name,
    size: data.byteLength,
    sha256: sha256.toString("hex"),
    chunk: chunkSize,
    total,
  };
  const frames: Uint8Array[] = [
    buildFrame(KIND_HEADER, transferId, 0, total, new TextEncoder().encode(JSON.stringify(header))),
  ];
  for (let i = 0; i < total; i++) {
    frames.push(
      buildFrame(KIND_DATA, transferId, i + 1, total, data.subarray(i * chunkSize, (i + 1) * chunkSize)),
    );
  }
  return frames;
}

function buildFrame(kind: number, transferId: Uint8Array, index: number, total: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_OVERHEAD + payload.byteLength);
  out.set(MAGIC, 0);
  out[3] = kind;
  out.set(transferId, 4);
  out[8] = index >> 8;
  out[9] = index & 0xff;
  out[10] = total >> 8;
  out[11] = total & 0xff;
  out.set(payload, FRAME_OVERHEAD);
  return out;
}

/** Parse decoded QR bytes into a frame; null if they are not a gitferry frame. */
export function parseFrame(bytes: Uint8Array): Frame | null {
  if (bytes.byteLength < FRAME_OVERHEAD) return null;
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) return null;
  const kind = bytes[3];
  if (kind !== KIND_HEADER && kind !== KIND_DATA && kind !== KIND_ACK) return null;
  return {
    kind: kind === KIND_HEADER ? "header" : kind === KIND_DATA ? "data" : "ack",
    transferId: Buffer.from(bytes.subarray(4, 8)).toString("hex"),
    index: (bytes[8] << 8) | bytes[9],
    total: (bytes[10] << 8) | bytes[11],
    payload: bytes.subarray(FRAME_OVERHEAD),
  };
}

/** Read an ack frame's flags + received-bitmap; null if it is not a valid ack. */
export function parseAck(frame: Frame): AckInfo | null {
  if (frame.kind !== "ack" || frame.total < 1) return null;
  if (frame.payload.byteLength < 1 + Math.ceil(frame.total / 8)) return null;
  const flags = frame.payload[0];
  const missing: number[] = [];
  for (let i = 1; i <= frame.total; i++) {
    if (!(frame.payload[1 + ((i - 1) >> 3)] & (0x80 >> ((i - 1) & 7)))) missing.push(i);
  }
  return {
    transferId: frame.transferId,
    total: frame.total,
    received: frame.total - missing.length,
    missing,
    headerMissing: !(flags & ACK_FLAG_HEADER),
    complete: Boolean(flags & ACK_FLAG_COMPLETE),
  };
}

export interface AssembleProgress {
  transferId?: string;
  header?: TransferHeader;
  /** data frames received so far */
  received: number;
  /** data frames expected (0 until any frame arrives) */
  total: number;
  /** data frame indices (1-based) still missing */
  missing: number[];
  headerMissing: boolean;
  complete: boolean;
  /** frames seen that belong to a different transfer */
  foreignFrames: number;
}

/** Collects frames in any order (duplicates and re-loops are fine) until complete. */
export class Assembler {
  private transferId?: string;
  private header?: TransferHeader;
  private total = 0;
  private chunks = new Map<number, Uint8Array>();
  private foreign = 0;

  /** Feed one parsed frame. Returns true if it advanced the transfer. */
  add(frame: Frame): boolean {
    if (frame.kind === "ack") return false; // acks flow receiver -> sender only
    if (this.transferId === undefined) this.transferId = frame.transferId;
    if (frame.transferId !== this.transferId) {
      this.foreign++;
      return false;
    }
    this.total = frame.total;
    if (frame.kind === "header") {
      if (this.header) return false;
      try {
        this.header = JSON.parse(new TextDecoder().decode(frame.payload)) as TransferHeader;
      } catch {
        return false;
      }
      return true;
    }
    if (frame.index < 1 || frame.index > frame.total) return false;
    if (this.chunks.has(frame.index)) return false;
    this.chunks.set(frame.index, frame.payload.slice());
    return true;
  }

  progress(): AssembleProgress {
    const missing: number[] = [];
    for (let i = 1; i <= this.total; i++) {
      if (!this.chunks.has(i)) missing.push(i);
    }
    const complete = this.total > 0 && this.header !== undefined && missing.length === 0;
    return {
      transferId: this.transferId,
      header: this.header,
      received: this.chunks.size,
      total: this.total,
      missing,
      headerMissing: this.header === undefined,
      complete,
      foreignFrames: this.foreign,
    };
  }

  /**
   * Build the ack frame this receiver should display back at the sender.
   * Deliberately tiny (flags + bitmap) so its QR stays low-version and easy to
   * scan across the gap. Null until the first frame reveals the transfer, or if
   * the transfer is too large for the bitmap to fit one QR.
   */
  ackFrame(): Uint8Array | null {
    if (this.transferId === undefined || this.total === 0) return null;
    const bitmapLen = Math.ceil(this.total / 8);
    if (FRAME_OVERHEAD + 1 + bitmapLen > MAX_ACK_FRAME_BYTES) return null;
    const payload = new Uint8Array(1 + bitmapLen);
    payload[0] =
      (this.header ? ACK_FLAG_HEADER : 0) |
      (this.header && this.chunks.size === this.total ? ACK_FLAG_COMPLETE : 0);
    for (const i of this.chunks.keys()) {
      payload[1 + ((i - 1) >> 3)] |= 0x80 >> ((i - 1) & 7);
    }
    return buildFrame(
      KIND_ACK,
      Buffer.from(this.transferId, "hex"),
      Math.min(this.chunks.size, MAX_FRAMES),
      this.total,
      payload,
    );
  }

  /** Reassemble and verify. Throws unless progress().complete and sha256 matches. */
  assemble(): { name: string; data: Buffer } {
    const p = this.progress();
    if (!p.complete || !this.header) {
      throw new GitFerryError(
        `transfer incomplete: ${p.received}/${p.total} data frames${p.headerMissing ? ", header frame missing" : ""}`,
      );
    }
    const data = Buffer.concat([...this.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c));
    if (data.byteLength !== this.header.size) {
      throw new GitFerryError(
        `reassembled size ${data.byteLength} does not match expected ${this.header.size}`,
      );
    }
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== this.header.sha256) {
      throw new GitFerryError(
        "sha256 mismatch after reassembly — a frame was corrupted in transit",
        "restart gitferry read and scan again",
      );
    }
    return { name: this.header.name, data };
  }
}
