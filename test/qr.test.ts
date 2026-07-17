import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeImage, rasterizeGroup, toMatricesUniform } from "../src/core/qrcodec.js";
import { runRead } from "../src/core/qrread.js";
import { Assembler, encodeFrames, parseFrame } from "../src/core/qrwire.js";
import { tmpDir } from "./helpers.js";

describe("QR wire protocol", () => {
  const data = new Uint8Array(randomBytes(10_000));
  const frames = encodeFrames(data, "bundle.gitferry", 300);

  it("frames carry magic, transfer id, and index/total numbering", () => {
    expect(frames.length).toBe(1 + Math.ceil(10_000 / 300));
    const header = parseFrame(frames[0])!;
    expect(header.kind).toBe("header");
    expect(header.index).toBe(0);
    expect(header.total).toBe(frames.length - 1);
    const chunk7 = parseFrame(frames[7])!;
    expect(chunk7.kind).toBe("data");
    expect(chunk7.index).toBe(7);
    expect(chunk7.transferId).toBe(header.transferId);
    expect(parseFrame(new TextEncoder().encode("not one of ours at all"))).toBeNull();
  });

  it("reassembles out of order, ignores duplicates, and reports exactly what is missing", () => {
    const a = new Assembler();
    const shuffled = [...frames].sort(() => Math.random() - 0.5);
    const held = parseFrame(frames[5])!; // withhold chunk 5
    for (const f of shuffled) {
      const frame = parseFrame(f)!;
      if (frame.kind === "data" && frame.index === 5) continue;
      a.add(frame);
      a.add(frame); // duplicates never advance anything
    }
    const p = a.progress();
    expect(p.complete).toBe(false);
    expect(p.missing).toEqual([5]);
    expect(p.headerMissing).toBe(false);
    expect(() => a.assemble()).toThrowError(/incomplete/);
    expect(a.add(held)).toBe(true);
    expect(a.progress().complete).toBe(true);
    const out = a.assemble();
    expect(out.name).toBe("bundle.gitferry");
    expect(new Uint8Array(out.data)).toEqual(data);
  });

  it("frames from a different transfer are counted but never mixed in", () => {
    const a = new Assembler();
    for (const f of frames) a.add(parseFrame(f)!);
    const other = encodeFrames(new Uint8Array(randomBytes(500)), "other.bin", 300);
    expect(a.add(parseFrame(other[1])!)).toBe(false);
    expect(a.progress().foreignFrames).toBe(1);
    expect(new Uint8Array(a.assemble().data)).toEqual(data);
  });

  it("a corrupted chunk is caught by the sha256 check", () => {
    const a = new Assembler();
    for (const [i, f] of frames.entries()) {
      const copy = f.slice();
      if (i === 3) copy[copy.length - 1] ^= 0xff; // flip a payload byte
      a.add(parseFrame(copy)!);
    }
    expect(a.progress().complete).toBe(true);
    expect(() => a.assemble()).toThrowError(/sha256 mismatch/);
  });
});

describe("QR optical round trip (encode -> pixels -> decode)", () => {
  const data = new Uint8Array(randomBytes(1_500));
  const frames = encodeFrames(data, "optical.bin", 400);
  const matrices = toMatricesUniform(frames);

  it("black & white: every frame survives rasterize + camera-style decode", () => {
    const a = new Assembler();
    for (const [i, m] of matrices.entries()) {
      const { rgba, width, height } = rasterizeGroup([m]);
      const decoded = decodeImage(rgba, width, height);
      expect(decoded.length).toBe(1);
      expect(decoded[0]).toEqual(frames[i]);
      a.add(parseFrame(decoded[0])!);
    }
    expect(new Uint8Array(a.assemble().data)).toEqual(data);
  });

  it("color: three frames multiplexed into R/G/B channels all decode back", () => {
    const group = [matrices[1], matrices[2], matrices[3]];
    const { rgba, width, height } = rasterizeGroup(group);
    const decoded = decodeImage(rgba, width, height);
    expect(decoded.length).toBe(3);
    const got = decoded.map((d) => Buffer.from(d).toString("hex")).sort();
    const want = [frames[1], frames[2], frames[3]].map((f) => Buffer.from(f).toString("hex")).sort();
    expect(got).toEqual(want);
  });

  it("a partial color group (2 frames) still decodes", () => {
    const { rgba, width, height } = rasterizeGroup([matrices[1], matrices[2]]);
    const decoded = decodeImage(rgba, width, height);
    expect(decoded.length).toBe(2);
  });
});

describe("read server end to end (fake camera)", () => {
  it("receives a color-mode transfer over HTTP and writes the verified file", async () => {
    const source = new Uint8Array(randomBytes(3_000));
    const frames = encodeFrames(source, "beam.gitferry", 256);
    const matrices = toMatricesUniform(frames);
    const groups: number[][] = [[0]];
    for (let i = 1; i < frames.length; i += 3) {
      groups.push([i, i + 1, i + 2].filter((j) => j < frames.length));
    }

    const dir = tmpDir();
    let url = "";
    const done = runRead({
      cwd: dir,
      port: 0,
      open: false,
      force: false,
      onListen: (u) => (url = u),
    });
    while (url === "") await new Promise((r) => setTimeout(r, 10));

    for (const g of groups) {
      const { rgba, width, height } = rasterizeGroup(g.map((i) => matrices[i]));
      const res = await fetch(`${url}frame?w=${width}&h=${height}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      });
      expect(res.ok).toBe(true);
    }

    const result = await done;
    expect(result.name).toBe("beam.gitferry");
    expect(result.outputPath).toBe(path.join(dir, "beam.gitferry"));
    expect(new Uint8Array(readFileSync(result.outputPath))).toEqual(source);
  }, 30_000);
});
