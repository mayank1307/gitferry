import { readFileSync, statSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, inflateRawSync, constants as zc } from "node:zlib";
import { zipSync } from "fflate";
import { GitFerryError } from "./errors.js";
import { assertSafePath, atomicWrite } from "./safety.js";

/** archive path -> file bytes */
export type Entries = Record<string, Uint8Array>;

/**
 * Bundle wrapper formats:
 *  - compact (default): "GFBR" magic + brotli stream of a *stored* (level 0)
 *    zip. Solid compression over all entries — ~30% smaller than a deflate
 *    zip on typical patch bundles, which directly cuts QR transfer time.
 *  - portable: a plain deflate zip any `unzip` can open (for bare devices).
 * readArchive auto-detects both, so old plain-zip bundles keep applying.
 */
const BROTLI_MAGIC = Uint8Array.from([0x47, 0x46, 0x42, 0x52]); // "GFBR"

export function writeArchive(filePath: string, entries: Entries, opts?: { portable?: boolean; limits?: ArchiveLimits }): void {
  const limits = opts?.limits ?? ARCHIVE_LIMITS;
  const names = Object.keys(entries);
  if (names.length > limits.entries) throw new GitFerryError("bundle exceeds entry count limit");
  let total = 0;
  const canonicalNames = new Set<string>();
  for (const name of names) {
    assertSafeEntryName(name);
    const canonical = name.normalize("NFC").toLowerCase();
    if (canonicalNames.has(canonical)) throw new GitFerryError(`duplicate or colliding archive path: ${name}`);
    canonicalNames.add(canonical);
    total += entries[name].byteLength;
    if (entries[name].byteLength > limits.entryBytes || total > limits.expandedBytes) throw new GitFerryError("bundle exceeds expanded size limit");
  }
  let output: Uint8Array;
  if (opts?.portable) {
    output = zipSync(entries, { level: 6 });
  } else {
    const stored = zipSync(entries, { level: 0 });
    if (stored.byteLength > limits.expandedBytes) throw new GitFerryError("bundle exceeds expanded ZIP size limit");
    const packed = brotliCompressSync(stored, {
      params: {
        [zc.BROTLI_PARAM_QUALITY]: 6,
        [zc.BROTLI_PARAM_SIZE_HINT]: stored.byteLength,
      },
    });
    output = Buffer.concat([BROTLI_MAGIC, packed]);
  }
  if (output.byteLength > limits.compressedBytes) throw new GitFerryError("bundle exceeds compressed size limit");
  atomicWrite(filePath, output);
}

export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  entries: 10_000,
});
export interface ArchiveLimits { compressedBytes: number; expandedBytes: number; entryBytes: number; entries: number; }

export function readArchive(filePath: string, limits: ArchiveLimits = ARCHIVE_LIMITS): Entries {
  let raw: Buffer;
  try {
    if (statSync(filePath).size > limits.compressedBytes) throw new GitFerryError("bundle exceeds compressed size limit");
    raw = readFileSync(filePath);
  } catch (e) {
    if (e instanceof GitFerryError) throw e;
    throw new GitFerryError(`cannot read bundle: ${filePath}`);
  }
  if (raw.length > limits.compressedBytes) throw new GitFerryError("bundle exceeds compressed size limit");
  if (raw.length >= 4 && BROTLI_MAGIC.every((b, i) => raw[i] === b)) {
    try { raw = brotliDecompressSync(raw.subarray(4), { maxOutputLength: limits.expandedBytes }); }
    catch { throw new GitFerryError(`corrupted or oversized gitferry bundle (bad brotli stream): ${filePath}`); }
  }
  try { return readZip(raw, limits); }
  catch (e) {
    if (e instanceof GitFerryError) throw e;
    throw new GitFerryError(`not a valid gitferry bundle: ${filePath}`);
  }
}

/** Parse central metadata before allocating or inflating any entry. ZIP64 is unnecessary at these limits. */
function readZip(zip: Buffer, limits: ArchiveLimits): Entries {
  const invalid = () => { throw new GitFerryError("not a valid gitferry bundle (unsupported or malformed zip)"); };
  let end = zip.length - 22;
  for (; end >= Math.max(0, zip.length - 65_558); end--) {
    if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
  }
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) return invalid();
  const count = zip.readUInt16LE(end + 10);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count || count === 65535) return invalid();
  if (count > limits.entries) throw new GitFerryError("bundle exceeds entry count limit");
  const centralEnd = zip.readUInt32LE(end + 16) + zip.readUInt32LE(end + 12);
  if (centralEnd !== end) return invalid();
  let offset = zip.readUInt32LE(end + 16);
  const files: {name: string; start: number; size: number; expanded: number; method: number}[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) return invalid();
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20), expanded = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    if ((flags & 1) || ![0, 8].includes(method) || offset + 46 + nameLength + extra + comment > end || local + 30 > offset) return invalid();
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    const isDirectory = name.endsWith("/");
    assertSafeEntryName(isDirectory ? name.slice(0, -1) : name);
    const canonical = name.normalize("NFC").toLowerCase();
    if (names.has(canonical)) throw new GitFerryError(`duplicate or colliding archive path: ${name}`);
    names.add(canonical);
    total += expanded;
    if (expanded > limits.entryBytes || total > limits.expandedBytes) throw new GitFerryError("bundle exceeds expanded size limit");
    if (zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 8) !== method || zip.readUInt16LE(local + 6) !== flags) return invalid();
    const localNameLength = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtra;
    if (start + size > zip.readUInt32LE(end + 16) || !nameBytes.equals(zip.subarray(local + 30, local + 30 + localNameLength))) return invalid();
    if (!isDirectory) files.push({ name, start, size, expanded, method });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== centralEnd) return invalid();
  const entries: Entries = Object.create(null);
  for (const file of files) {
    const data = zip.subarray(file.start, file.start + file.size);
    const bytes = file.method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, file.expanded) });
    if (bytes.length !== file.expanded) return invalid();
    entries[file.name] = new Uint8Array(bytes);
  }
  return entries;
}

export function assertSafeEntryName(name: string): void { assertSafePath(name); }
