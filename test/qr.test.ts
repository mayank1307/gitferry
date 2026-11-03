import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeImage, rasterizeGroup, toMatricesUniform, toMatrix } from "../src/core/qrcodec.js";
import { runRead } from "../src/core/qrread.js";
import { prepareShow, runBrowserShow } from "../src/core/qrshow.js";
import { Assembler, encodeFrames, parseAck, parseFrame } from "../src/core/qrwire.js";
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

  it("ack round trip: the receiver's bitmap tells the sender exactly what to resend", () => {
    const a = new Assembler();
    expect(a.ackFrame()).toBeNull(); // nothing seen yet — no ack to show
    const skip = new Set([2, 9, 14]);
    for (const f of frames) {
      const frame = parseFrame(f)!;
      if (frame.kind === "data" && skip.has(frame.index)) continue;
      a.add(frame);
    }
    const ack = parseAck(parseFrame(a.ackFrame()!)!)!;
    expect(ack.transferId).toBe(parseFrame(frames[0])!.transferId);
    expect(ack.missing).toEqual([2, 9, 14]);
    expect(ack.headerMissing).toBe(false);
    expect(ack.complete).toBe(false);
    for (const i of skip) a.add(parseFrame(frames[i])!);
    const full = parseAck(parseFrame(a.ackFrame()!)!)!;
    expect(full.missing).toEqual([]);
    expect(full.complete).toBe(true);
    // acks flow receiver -> sender only; feeding one back never advances a transfer
    expect(new Assembler().add(parseFrame(a.ackFrame()!)!)).toBe(false);
  });

  it("the ack QR stays small and high-ECC so it is easy to scan", () => {
    const a = new Assembler();
    for (const f of frames) a.add(parseFrame(f)!); // 34 chunks -> 1 flags byte + 5 bitmap bytes
    const bytes = a.ackFrame()!;
    expect(bytes.byteLength).toBeLessThanOrEqual(12 + 1 + Math.ceil(frames.length / 8));
    const m = toMatrix(bytes, "Q");
    expect(m.size).toBeLessThanOrEqual(29); // QR version <= 3 even at ECC Q
    // and it survives a camera-style rasterize -> decode round trip
    const { rgba, width, height } = rasterizeGroup([m]);
    const decoded = decodeImage(rgba, width, height);
    expect(decoded.length).toBe(1);
    expect(parseFrame(decoded[0])!.kind).toBe("ack");
  });

  it("every ack frame it hands out actually renders at ECC Q, or is withheld", () => {
    // The received-bitmap grows with frame count; past ECC-Q's version-40 byte
    // capacity the ack cannot be one QR, so ackFrame() must return null rather
    // than emit bytes that crash toMatrix('Q') on the receiver.
    const header = (frameCount: number): void => {
      // only the header is needed: 'total' alone sizes the received-bitmap
      const a = new Assembler();
      a.add(parseFrame(encodeFrames(new Uint8Array(frameCount * 16), "x.bin", 16)[0])!);
      const bytes = a.ackFrame();
      if (bytes) expect(() => toMatrix(bytes, "Q")).not.toThrow();
      else expect(frameCount).toBeGreaterThan(13200);
    };
    header(13200); // largest bitmap that still fits one ECC-Q QR -> renders
    header(13201); // one frame more -> ackFrame() withholds instead of crashing
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

describe("show server ack channel (fake camera)", () => {
  it("decodes the receiver's progress QR and reports missing chunks, then complete", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "beam.gitferry");
    writeFileSync(file, randomBytes(2_000));
    const plan = prepareShow(file, { chunk: 256, color: false });
    const { url, close, done } = await runBrowserShow(plan, { fps: 4, retryFps: 1, port: 0, open: false });
    try {
      // a receiver that caught everything except chunks 3 and 6
      const receiver = new Assembler();
      for (const f of plan.frames) {
        const frame = parseFrame(f)!;
        if (frame.kind === "data" && (frame.index === 3 || frame.index === 6)) continue;
        receiver.add(frame);
      }
      const postAck = async (): Promise<{ hasAck: boolean; missing?: number[]; complete?: boolean }> => {
        const { rgba, width, height } = rasterizeGroup([toMatrix(receiver.ackFrame()!, "Q")]);
        const res = await fetch(`${url}ack?w=${width}&h=${height}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        });
        expect(res.ok).toBe(true);
        return (await res.json()) as { hasAck: boolean; missing?: number[]; complete?: boolean };
      };
      const partial = await postAck();
      expect(partial.hasAck).toBe(true);
      expect(partial.missing).toEqual([3, 6]);
      expect(partial.complete).toBe(false);
      receiver.add(parseFrame(plan.frames[3])!);
      receiver.add(parseFrame(plan.frames[6])!);
      const full = await postAck();
      expect(full.missing).toEqual([]);
      expect(full.complete).toBe(true);
      // reading a complete ack resolves done(), which is what lets the CLI stop
      const finalAck = await done;
      expect(finalAck.complete).toBe(true);
      expect(finalAck.received).toBe(finalAck.total);
    } finally {
      close();
    }
  }, 30_000);
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

    let last: { done: boolean; ack: { size: number; bits: string } | null } | undefined;
    for (const g of groups) {
      const { rgba, width, height } = rasterizeGroup(g.map((i) => matrices[i]));
      const res = await fetch(`${url}frame?w=${width}&h=${height}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      });
      expect(res.ok).toBe(true);
      last = (await res.json()) as typeof last;
    }
    // every response after the first frame carries the progress QR for the sender
    expect(last?.done).toBe(true);
    expect(last?.ack).not.toBeNull();

    const result = await done;
    expect(result.name).toBe("beam.gitferry");
    expect(result.outputPath).toBe(path.join(dir, "beam.gitferry"));
    expect(new Uint8Array(readFileSync(result.outputPath))).toEqual(source);
  }, 30_000);
});
