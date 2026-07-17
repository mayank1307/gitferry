import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { apply } from "../src/core/apply.js";
import { GitFerryError } from "../src/core/errors.js";
import { inspect } from "../src/core/inspect.js";
import { pack } from "../src/core/pack.js";
import { cloneRepo, commitAll, g, initRepo, tmpDir, write } from "./helpers.js";

/**
 * Machine A: base commit → clone to machine B → A gains 2 commits,
 * a staged edit, an unstaged edit, and untracked files (incl. binary).
 * Pack on A, apply on B, assert B mirrors A exactly.
 */
describe("round trip: pack on A, apply on B", () => {
  let repoA: string;
  let repoB: string;
  let baseSha: string;
  let bundlePath: string;
  const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f]);

  beforeAll(async () => {
    repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "base.txt", "hello\n");
    write(repoA, "src/app.js", "console.log('v1')\n");
    baseSha = commitAll(repoA, "base");

    repoB = cloneRepo(repoA); // machine B, synced at base — then the air gap begins

    // Machine A moves ahead:
    write(repoA, "feature.txt", "feat v1\n");
    commitAll(repoA, "add feature");
    write(repoA, "base.txt", "hello v2\n");
    commitAll(repoA, "update base");
    // staged edit
    write(repoA, "base.txt", "hello v2\nstaged line\n");
    g(repoA, "add", "base.txt");
    // unstaged edit on a different file
    write(repoA, "src/app.js", "console.log('v1')\nconsole.log('unstaged')\n");
    // untracked: text + binary + ignored
    write(repoA, "notes/todo.md", "- ship it\n");
    write(repoA, "assets/logo.bin", binaryBytes);
    write(repoA, ".gitignore", "ignored.log\n");
    write(repoA, "ignored.log", "should not travel\n");

    const result = await pack({
      cwd: repoA,
      base: baseSha,
      output: path.join(tmpDir(), "changes.gitferry"),
    });
    bundlePath = result.outputPath;
  });

  it("pack produces a verified, complete manifest", () => {
    const { manifest } = inspect(bundlePath);
    expect(manifest.stats.commits).toBe(2);
    expect(manifest.contents.commits.map((c) => c.subject)).toEqual(["add feature", "update base"]);
    expect(manifest.contents.worktree).toEqual({ staged: true, unstaged: true });
    // .gitignore itself is untracked; ignored.log must NOT be included
    expect(manifest.contents.untracked.sort()).toEqual([".gitignore", "assets/logo.bin", "notes/todo.md"]);
    expect(manifest.repo.base).toBe(baseSha);
  });

  it("apply reproduces commits, staged/unstaged state, and untracked files on B", async () => {
    const result = await apply({ cwd: repoB, bundlePath });
    expect(result.appliedCommits).toBe(2);
    expect(result.stagedApplied).toBe(true);
    expect(result.unstagedApplied).toBe(true);
    expect(result.untrackedWritten.sort()).toEqual([".gitignore", "assets/logo.bin", "notes/todo.md"]);

    // History replayed with metadata
    const log = g(repoB, "log", "--format=%s", "main");
    expect(log.split("\n")).toEqual(["update base", "add feature", "base"]);
    expect(g(repoB, "log", "-1", "--format=%an", "main")).toBe("Test User");

    // File contents match machine A
    for (const f of ["base.txt", "feature.txt", "src/app.js", "notes/todo.md"]) {
      expect(readFileSync(path.join(repoB, f))).toEqual(readFileSync(path.join(repoA, f)));
    }
    expect(readFileSync(path.join(repoB, "assets/logo.bin"))).toEqual(binaryBytes);

    // Staged vs unstaged state mirrors A: base.txt staged, src/app.js unstaged
    const status = g(repoB, "status", "--porcelain").split("\n").sort();
    expect(status).toContain("M  base.txt");
    expect(status).toContain(" M src/app.js");
  });

  it("dry-run changes nothing", async () => {
    const repoC = cloneRepo(repoA); // fresh target at... clone gets full history; reset to base
    g(repoC, "reset", "--hard", baseSha);
    const before = g(repoC, "rev-parse", "HEAD");
    const result = await apply({ cwd: repoC, bundlePath, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(g(repoC, "rev-parse", "HEAD")).toBe(before);
    expect(g(repoC, "status", "--porcelain")).toBe("");
  });
});

describe("guards and failure modes", () => {
  it("rejects a tampered bundle (checksum mismatch)", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "one\n");
    commitAll(repoA, "base");
    write(repoA, "a.txt", "two\n");
    const { outputPath } = await pack({ cwd: repoA, output: path.join(tmpDir(), "t.gitferry") });

    // Tamper with the unstaged patch inside the zip, keep manifest as-is
    const entries = unzipSync(new Uint8Array(readFileSync(outputPath)));
    entries["worktree/unstaged.patch"] = strToU8(
      strFromU8(entries["worktree/unstaged.patch"]).replace("two", "evil"),
    );
    writeFileSync(outputPath, zipSync(entries));

    expect(() => inspect(outputPath)).toThrowError(/checksum mismatch/);
  });

  it("refuses to apply to an unrelated repository without --force", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "one\n");
    commitAll(repoA, "base");
    write(repoA, "a.txt", "two\n");
    const { outputPath } = await pack({ cwd: repoA, output: path.join(tmpDir(), "t.gitferry") });

    const stranger = tmpDir();
    initRepo(stranger);
    write(stranger, "other.txt", "unrelated\n");
    commitAll(stranger, "unrelated base");

    await expect(apply({ cwd: stranger, bundlePath: outputPath })).rejects.toThrowError(
      /does not look like the same repository/,
    );
  });

  it("refuses to apply onto a dirty tracked tree without --force", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "one\n");
    const base = commitAll(repoA, "base");
    const repoB = cloneRepo(repoA);
    write(repoA, "a.txt", "two\n");
    commitAll(repoA, "change");
    const { outputPath } = await pack({ cwd: repoA, base, output: path.join(tmpDir(), "t.gitferry") });

    write(repoB, "a.txt", "local dirt\n");
    await expect(apply({ cwd: repoB, bundlePath: outputPath })).rejects.toThrowError(
      /uncommitted changes/,
    );
  });

  it("skips existing untracked files unless forced", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "one\n");
    const base = commitAll(repoA, "base");
    const repoB = cloneRepo(repoA);
    write(repoA, "new.md", "from A\n");
    const { outputPath } = await pack({ cwd: repoA, base, output: path.join(tmpDir(), "t.gitferry") });

    write(repoB, "new.md", "B's own version\n");
    const result = await apply({ cwd: repoB, bundlePath: outputPath });
    expect(result.untrackedSkipped).toEqual(["new.md"]);
    expect(readFileSync(path.join(repoB, "new.md"), "utf8")).toBe("B's own version\n");

    const forced = await apply({ cwd: repoB, bundlePath: outputPath, force: true });
    expect(forced.untrackedWritten).toEqual(["new.md"]);
    expect(readFileSync(path.join(repoB, "new.md"), "utf8")).toBe("from A\n");
  });

  it("3-way merges when the target has diverged (content-compatible)", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "line1\nline2\nline3\n");
    const base = commitAll(repoA, "base");
    const repoB = cloneRepo(repoA);

    // A commits an edit to line1
    write(repoA, "a.txt", "line1 changed by A\nline2\nline3\n");
    commitAll(repoA, "A edit");
    const { outputPath } = await pack({ cwd: repoA, base, output: path.join(tmpDir(), "t.gitferry") });

    // B has its own commit touching line3 (non-conflicting)
    write(repoB, "a.txt", "line1\nline2\nline3 changed by B\n");
    commitAll(repoB, "B edit");

    const result = await apply({ cwd: repoB, bundlePath: outputPath });
    expect(result.appliedCommits).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/differs from the bundle base/);
    expect(readFileSync(path.join(repoB, "a.txt"), "utf8")).toBe(
      "line1 changed by A\nline2\nline3 changed by B\n",
    );
  });

  it("packing a repo with nothing to share fails clearly", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "one\n");
    commitAll(repoA, "base");
    await expect(pack({ cwd: repoA, output: path.join(tmpDir(), "t.gitferry") })).rejects.toThrowError(
      /nothing to pack/,
    );
  });

  it("CLI end-to-end: pack → inspect → apply via the built binary", async () => {
    const repoA = tmpDir();
    initRepo(repoA);
    write(repoA, "a.txt", "one\n");
    const base = commitAll(repoA, "base");
    const repoB = cloneRepo(repoA);
    write(repoA, "a.txt", "two\n");
    commitAll(repoA, "change");

    const cli = path.resolve(__dirname, "../dist/cli.js");
    const bundle = path.join(tmpDir(), "cli.gitferry");
    const run = (cwd: string, args: string[]) =>
      execFileSync("node", [cli, ...args], { cwd, encoding: "utf8" });

    run(repoA, ["pack", "--base", base, "-o", bundle]);
    const inspectOut = run(repoA, ["inspect", bundle]);
    expect(inspectOut).toContain("all checksums verified");
    const applyOut = run(repoB, ["apply", bundle]);
    expect(applyOut).toContain("bundle applied");
    expect(readFileSync(path.join(repoB, "a.txt"), "utf8")).toBe("two\n");
  });
});
