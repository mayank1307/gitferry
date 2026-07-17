import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inspect } from "../src/core/inspect.js";
import { pack, parseSelectionChoice, selectionIncludes } from "../src/core/pack.js";
import { commitAll, g, initRepo, tmpDir, write } from "./helpers.js";

describe("pack selection: all / uncommitted / staged / unstaged / committed", () => {
  let repo: string;
  let baseSha: string;

  beforeAll(() => {
    repo = tmpDir();
    initRepo(repo);
    write(repo, "a.txt", "line1\n");
    write(repo, "b.txt", "b1\n");
    baseSha = commitAll(repo, "base");
    // one unpushed commit
    write(repo, "a.txt", "line1\ncommitted\n");
    commitAll(repo, "committed change");
    // staged edit
    write(repo, "a.txt", "line1\ncommitted\nstaged\n");
    g(repo, "add", "a.txt");
    // unstaged edit on another file
    write(repo, "b.txt", "b1\nunstaged\n");
    // untracked file
    write(repo, "new.md", "untracked\n");
  });

  const packOnly = async (sel: Parameters<typeof selectionIncludes>[0]) =>
    inspect(
      (
        await pack({
          cwd: repo,
          base: baseSha,
          output: path.join(tmpDir(), `${sel}.gitferry`),
          ...selectionIncludes(sel),
        })
      ).outputPath,
    ).manifest;

  it("all: commits + staged + unstaged + untracked", async () => {
    const m = await packOnly("all");
    expect(m.stats.commits).toBe(1);
    expect(m.contents.worktree).toEqual({ staged: true, unstaged: true });
    expect(m.contents.untracked).toEqual(["new.md"]);
  });

  it("uncommitted: staged + unstaged + untracked, no commits", async () => {
    const m = await packOnly("uncommitted");
    expect(m.stats.commits).toBe(0);
    expect(m.contents.worktree).toEqual({ staged: true, unstaged: true });
    expect(m.contents.untracked).toEqual(["new.md"]);
  });

  it("staged: index changes only", async () => {
    const m = await packOnly("staged");
    expect(m.stats.commits).toBe(0);
    expect(m.contents.worktree).toEqual({ staged: true, unstaged: false });
    expect(m.contents.untracked).toEqual([]);
  });

  it("unstaged: worktree edits + untracked, nothing staged or committed", async () => {
    const m = await packOnly("unstaged");
    expect(m.stats.commits).toBe(0);
    expect(m.contents.worktree).toEqual({ staged: false, unstaged: true });
    expect(m.contents.untracked).toEqual(["new.md"]);
  });

  it("committed: unpushed commits only", async () => {
    const m = await packOnly("committed");
    expect(m.stats.commits).toBe(1);
    expect(m.contents.commits[0].subject).toBe("committed change");
    expect(m.contents.worktree).toEqual({ staged: false, unstaged: false });
    expect(m.contents.untracked).toEqual([]);
  });

  it("a selection with nothing behind it fails with a precise message", async () => {
    const clean = tmpDir();
    initRepo(clean);
    write(clean, "x.txt", "x\n");
    commitAll(clean, "base");
    write(clean, "x.txt", "x\nunstaged only\n"); // unstaged edit exists, but we ask for staged
    await expect(
      pack({ cwd: clean, output: path.join(tmpDir(), "s.gitferry"), ...selectionIncludes("staged") }),
    ).rejects.toThrowError(/nothing to pack: no staged changes/);
  });

  it("CLI --only staged / --only unstaged --no-untracked", () => {
    const cli = path.resolve(__dirname, "../dist/cli.js");
    const run = (args: string[]) => execFileSync("node", [cli, ...args], { cwd: repo, encoding: "utf8" });

    const stagedBundle = path.join(tmpDir(), "only-staged.gitferry");
    run(["pack", "--base", baseSha, "--only", "staged", "-o", stagedBundle]);
    expect(inspect(stagedBundle).manifest.contents).toMatchObject({
      worktree: { staged: true, unstaged: false },
      untracked: [],
      commits: [],
    });

    const trimmed = path.join(tmpDir(), "only-unstaged.gitferry");
    run(["pack", "--base", baseSha, "--only", "unstaged", "--no-untracked", "-o", trimmed]);
    expect(inspect(trimmed).manifest.contents).toMatchObject({
      worktree: { staged: false, unstaged: true },
      untracked: [],
      commits: [],
    });

    expect(() => run(["pack", "--only", "everythingg"])).toThrowError(/unknown --only value/);
  });

  it("parseSelectionChoice: numbers, names, aliases, default, garbage", () => {
    expect(parseSelectionChoice("")).toBe("uncommitted"); // Enter = default
    expect(parseSelectionChoice("1")).toBe("all");
    expect(parseSelectionChoice("3")).toBe("staged");
    expect(parseSelectionChoice("5")).toBe("committed");
    expect(parseSelectionChoice(" Unstaged ")).toBe("unstaged");
    expect(parseSelectionChoice("commits")).toBe("committed");
    expect(parseSelectionChoice("9")).toBeUndefined();
    expect(parseSelectionChoice("everything")).toBeUndefined();
    expect(parseSelectionChoice("", null)).toBeUndefined();
  });
});
