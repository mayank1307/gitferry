#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { apply } from "./core/apply.js";
import { GitFerryError } from "./core/errors.js";
import { inspect } from "./core/inspect.js";
import type { Manifest } from "./core/manifest.js";
import {
  pack,
  parseSelectionChoice,
  SELECTION_SUMMARY,
  SELECTIONS,
  type Selection,
  selectionIncludes,
} from "./core/pack.js";
import { runRead } from "./core/qrread.js";
import { formatBytes, prepareShow, runBrowserShow, runTerminalShow } from "./core/qrshow.js";
import { MAX_CHUNK } from "./core/qrwire.js";
import { VERSION } from "./version.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const cyan = paint("36");

const program = new Command();
program
  .name("gitferry")
  .description("Portable git-change bundles for air-gapped repos: pack changes here, apply them there.")
  .version(VERSION);

program
  .command("pack")
  .description("bundle unpushed commits, working-tree changes, and untracked files into a single .gitferry file")
  .option("-C, --cwd <dir>", "repository directory", ".")
  .option("-o, --output <file>", "output bundle path (default: <repo>-<branch>-<sha>.gitferry)")
  .option("--base <ref>", "commit the bundle applies onto (default: merge-base with upstream)")
  .option("--only <what>", `what to pack: ${SELECTIONS.join("|")} (skips the interactive question)`)
  .option("--no-commits", "exclude unpushed commits")
  .option("--no-worktree", "exclude staged/unstaged changes")
  .option("--no-untracked", "exclude untracked files")
  .action(async (opts) => {
    let selection: Selection | undefined;
    if (opts.only) {
      selection = parseSelectionChoice(String(opts.only), null);
      if (!selection) {
        throw new GitFerryError(`unknown --only value "${opts.only}"`, `use one of: ${SELECTIONS.join(", ")}`);
      }
    } else if (
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      opts.commits &&
      opts.worktree &&
      opts.untracked
    ) {
      selection = await askSelection();
    }
    const inc: Partial<ReturnType<typeof selectionIncludes>> = selection ? selectionIncludes(selection) : {};
    const result = await pack({
      cwd: opts.cwd,
      output: opts.output,
      base: opts.base,
      includeCommits: (inc.includeCommits ?? true) && opts.commits,
      includeStaged: inc.includeStaged,
      includeUnstaged: inc.includeUnstaged,
      includeWorktree: opts.worktree,
      includeUntracked: (inc.includeUntracked ?? true) && opts.untracked,
    });
    printWarnings(result.warnings);
    printManifestSummary(result.manifest);
    console.log(`\n${green("✓")} wrote ${bold(result.outputPath)}`);
    console.log(dim(`  apply on the other machine with: gitferry apply ${result.outputPath.split("/").pop()}`));
  });

program
  .command("inspect")
  .argument("<bundle>", "path to a .gitferry bundle")
  .description("verify a bundle's integrity and show what it contains (changes nothing)")
  .action(async (bundlePath: string) => {
    const result = inspect(bundlePath);
    printManifestSummary(result.manifest);
    console.log(`\n${green("✓")} all checksums verified`);
  });

program
  .command("apply")
  .argument("<bundle>", "path to a .gitferry bundle")
  .description("validate and apply a bundle to the repository")
  .option("-C, --cwd <dir>", "repository directory", ".")
  .option("--dry-run", "validate and show what would happen without changing anything")
  .option("--force", "override repo-fingerprint, dirty-tree, and overwrite guards")
  .option("--no-untracked", "skip untracked files in the bundle")
  .action(async (bundlePath: string, opts) => {
    const result = await apply({
      cwd: opts.cwd,
      bundlePath,
      force: opts.force,
      dryRun: opts.dryRun,
      includeUntracked: opts.untracked,
    });
    printWarnings(result.warnings);
    for (const step of result.steps) {
      console.log(`${result.dryRun ? cyan("→") : green("✓")} ${step}`);
    }
    if (result.dryRun) {
      console.log(`\n${cyan("dry run")} — nothing was changed`);
    } else {
      console.log(`\n${green("✓")} bundle applied`);
      console.log(dim("  review with: git status && git log --oneline"));
    }
  });

program
  .command("show")
  .argument("<file>", "file to transmit (usually a .gitferry bundle)")
  .description("display a file as a looping sequence of numbered QR codes — receive with `gitferry read`")
  .option("--chunk <bytes>", `payload bytes per QR frame, 16-${MAX_CHUNK} (default: 300 terminal, 800 browser)`)
  .option("--fps <n>", "QR frames per second (default: 2 terminal, 4 browser)")
  .option("--browser", "show in a local browser page instead of the terminal (bigger, denser)")
  .option("--color", "experimental: 3x density by packing 3 chunks into the R/G/B channels of each image (implies --browser)")
  .option("--port <n>", "port for the --browser page (default: random)", "0")
  .option("--no-open", "print the --browser URL without opening it")
  .action(async (file: string, opts) => {
    const browser = Boolean(opts.browser || opts.color);
    const chunk = opts.chunk ? Number(opts.chunk) : browser ? 800 : 300;
    const fps = opts.fps ? Number(opts.fps) : browser ? 4 : 2;
    if (!Number.isFinite(chunk) || !Number.isFinite(fps) || fps <= 0) {
      throw new GitFerryError("--chunk and --fps must be numbers");
    }
    const plan = prepareShow(file, { chunk, color: Boolean(opts.color) });
    if (browser) {
      const { url } = await runBrowserShow(plan, { fps, port: Number(opts.port), open: opts.open });
      console.log(`${bold(plan.fileName)} · ${formatBytes(plan.byteSize)} · ${plan.dataFrames} chunks${plan.color ? cyan(" · color mode") : ""}`);
      console.log(`${green("✓")} showing at ${bold(url)} ${dim("(loops until you Ctrl+C)")}`);
      console.log(dim("  on the other machine: gitferry read — point its camera at that page"));
      await new Promise<never>(() => {});
    } else {
      await runTerminalShow(plan, fps);
    }
  });

program
  .command("read")
  .description("receive a file sent with `gitferry show`: opens a webcam page and reassembles the numbered QR frames")
  .option("-o, --output <file>", "where to write the received file (default: the sender's filename)")
  .option("--port <n>", "port for the camera page (default: random)", "0")
  .option("--no-open", "print the camera-page URL without opening it")
  .option("--force", "overwrite the output file if it already exists")
  .action(async (opts) => {
    console.log(`${bold("gitferry read")} — waiting for QR frames ${dim("(Ctrl+C to stop)")}`);
    let lastLine = 0;
    const result = await runRead({
      output: opts.output,
      port: Number(opts.port),
      open: opts.open,
      force: Boolean(opts.force),
      onListen: (url) => console.log(`  camera page: ${bold(url)} ${dim("(open it on a machine with a webcam — this one)")}`),
      onProgress: (p) => {
        if (!process.stdout.isTTY) return;
        const line =
          p.total === 0
            ? "  looking for the first frame…"
            : `  ${p.received}/${p.total} chunks · header ${p.headerMissing ? yellow("pending") : green("✓")}` +
              (p.missing.length > 0 && p.missing.length <= 12 ? dim(` · missing #${p.missing.join(" #")}`) : "") +
              (p.foreignFrames > 0 ? yellow(" · other transfer visible!") : "");
        process.stdout.write(`\r${line}${" ".repeat(Math.max(0, lastLine - line.length))}`);
        lastLine = line.length;
      },
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`${green("✓")} all frames received, sha256 verified`);
    console.log(`${green("✓")} wrote ${bold(result.outputPath)} ${dim(`(${formatBytes(result.bytes)})`)}`);
    if (result.outputPath.endsWith(".gitferry")) {
      console.log(dim(`  next: gitferry inspect ${result.outputPath.split("/").pop()} && gitferry apply ${result.outputPath.split("/").pop()}`));
    }
    process.exit(0);
  });

/** Interactive picker for what a pack should carry. Enter = uncommitted. */
async function askSelection(): Promise<Selection> {
  console.log(bold("what should travel?"));
  SELECTIONS.forEach((sel, i) => {
    const isDefault = sel === "uncommitted";
    const name = (isDefault ? cyan : (s: string) => s)(sel.padEnd(12));
    console.log(`  ${i + 1}. ${name} ${dim(SELECTION_SUMMARY[sel])}${isDefault ? cyan("  ← default") : ""}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question(`select 1-${SELECTIONS.length} or a name ${dim("[uncommitted]")}: `);
      const sel = parseSelectionChoice(answer);
      if (sel) return sel;
      console.log(yellow(`  didn't catch that — try a number 1-${SELECTIONS.length} or one of: ${SELECTIONS.join(", ")}`));
    }
  } finally {
    rl.close();
  }
}

function printManifestSummary(m: Manifest): void {
  const { repo, contents, stats } = m;
  console.log(bold(`${repo.repoName} @ ${repo.branch}`));
  console.log(`  head    ${repo.head.slice(0, 12)}`);
  console.log(`  base    ${repo.base.slice(0, 12)}${repo.baseRef ? dim(` (${repo.baseRef})`) : ""}`);
  console.log(`  created ${m.createdAt}  ${dim(`(gitferry v${m.tool.version}, format v${m.formatVersion})`)}`);
  if (contents.commits.length > 0) {
    console.log(`  commits ${contents.commits.length}`);
    for (const c of contents.commits) {
      console.log(dim(`    ${c.sha.slice(0, 7)} ${c.subject}`));
    }
  }
  const wt: string[] = [];
  if (contents.worktree.staged) wt.push("staged");
  if (contents.worktree.unstaged) wt.push("unstaged");
  if (wt.length > 0) {
    console.log(
      `  worktree ${wt.join(" + ")} ${dim(`(${stats.filesChanged} files, +${stats.insertions}/-${stats.deletions})`)}`,
    );
  }
  if (contents.untracked.length > 0) {
    console.log(`  untracked ${contents.untracked.length}`);
    for (const p of contents.untracked) console.log(dim(`    ${p}`));
  }
}

function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.log(`${yellow("!")} ${w}`);
}

program.parseAsync().catch((e: unknown) => {
  if (e instanceof GitFerryError) {
    console.error(`${red("error:")} ${e.message}`);
    if (e.hint) console.error(dim(`  hint: ${e.hint}`));
  } else {
    console.error(`${red("error:")} ${(e as Error).message}`);
  }
  process.exit(1);
});
