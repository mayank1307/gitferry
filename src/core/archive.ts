import { readFileSync, writeFileSync } from "node:fs";
import { zipSync, unzipSync } from "fflate";
import { GitFerryError } from "./errors.js";

/** archive path -> file bytes */
export type Entries = Record<string, Uint8Array>;

export function writeArchive(filePath: string, entries: Entries): void {
  writeFileSync(filePath, zipSync(entries, { level: 6 }));
}

export function readArchive(filePath: string): Entries {
  let raw: Buffer;
  try {
    raw = readFileSync(filePath);
  } catch {
    throw new GitFerryError(`cannot read bundle: ${filePath}`);
  }
  let unzipped: Entries;
  try {
    unzipped = unzipSync(new Uint8Array(raw));
  } catch {
    throw new GitFerryError(`not a valid gitferry bundle (zip): ${filePath}`);
  }
  // Drop directory entries; validate names to prevent zip-slip on extraction.
  const entries: Entries = {};
  for (const [name, data] of Object.entries(unzipped)) {
    if (name.endsWith("/")) continue;
    assertSafeEntryName(name);
    entries[name] = data;
  }
  return entries;
}

/** Reject absolute paths, backslashes, and `..` traversal in archive entry names. */
export function assertSafeEntryName(name: string): void {
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    /(^|\/)\.\.(\/|$)/.test(name) ||
    /^[a-zA-Z]:/.test(name)
  ) {
    throw new GitFerryError(`unsafe path in bundle: ${name}`, "the bundle may be corrupted or malicious");
  }
}
