import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { readArchive, writeArchive } from "../src/core/archive.js";
import { tmpDir } from "./helpers.js";

const sampleEntries = () => ({
  "manifest.json": new TextEncoder().encode(JSON.stringify({ v: 1, note: "x".repeat(500) })),
  "worktree/unstaged.patch": new TextEncoder().encode("diff --git a/f b/f\n".repeat(300)),
  "untracked/blob.bin": new Uint8Array(randomBytes(2048)),
});

describe("bundle archive format", () => {
  it("compact (default) round-trips and starts with the GFBR magic", () => {
    const dir = tmpDir();
    const file = path.join(dir, "c.gitferry");
    const entries = sampleEntries();
    writeArchive(file, entries);
    const raw = readFileSync(file);
    expect([...raw.subarray(0, 4)]).toEqual([0x47, 0x46, 0x42, 0x52]); // "GFBR"
    const back = readArchive(file);
    expect(Object.keys(back).sort()).toEqual(Object.keys(entries).sort());
    expect(back["untracked/blob.bin"]).toEqual(entries["untracked/blob.bin"]);
  });

  it("portable writes a plain zip (PK magic) that round-trips", () => {
    const dir = tmpDir();
    const file = path.join(dir, "p.gitferry");
    writeArchive(file, sampleEntries(), { portable: true });
    const raw = readFileSync(file);
    expect(raw[0]).toBe(0x50); // P
    expect(raw[1]).toBe(0x4b); // K
    expect(Object.keys(readArchive(file)).length).toBe(3);
  });

  it("compact is meaningfully smaller than the portable zip on patch-like text", () => {
    const dir = tmpDir();
    const entries = sampleEntries();
    const compact = path.join(dir, "c.gitferry");
    const portable = path.join(dir, "p.gitferry");
    writeArchive(compact, entries);
    writeArchive(portable, entries, { portable: true });
    expect(readFileSync(compact).byteLength).toBeLessThan(readFileSync(portable).byteLength);
  });

  it("still reads pre-0.2 bundles (plain deflate zip, no magic)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "old.gitferry");
    const entries = sampleEntries();
    writeFileSync(file, zipSync(entries, { level: 6 })); // exactly what old writeArchive did
    const back = readArchive(file);
    expect(back["untracked/blob.bin"]).toEqual(entries["untracked/blob.bin"]);
  });

  it("rejects a truncated compact bundle with a clear error", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad.gitferry");
    writeArchive(file, sampleEntries());
    const raw = readFileSync(file);
    writeFileSync(file, raw.subarray(0, raw.byteLength - 10));
    expect(() => readArchive(file)).toThrowError(/brotli|not a valid/);
  });
});
