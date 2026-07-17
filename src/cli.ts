#!/usr/bin/env node
import { Command } from "commander";
import { apply } from "./core/apply.js";
import { GitFerryError } from "./core/errors.js";
import { inspect } from "./core/inspect.js";
import type { Manifest } from "./core/manifest.js";
import { pack } from "./core/pack.js";
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
  .option("--no-commits", "exclude unpushed commits")
  .option("--no-worktree", "exclude staged/unstaged changes")
  .option("--no-untracked", "exclude untracked files")
  .action(async (opts) => {
    const result = await pack({
      cwd: opts.cwd,
      output: opts.output,
      base: opts.base,
      includeCommits: opts.commits,
      includeWorktree: opts.worktree,
      includeUntracked: opts.untracked,
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
