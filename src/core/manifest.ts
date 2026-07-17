import { createHash } from "node:crypto";
import { z } from "zod";

export const FORMAT_VERSION = 1;

export const ManifestSchema = z.object({
  formatVersion: z.number().int(),
  tool: z.object({ name: z.string(), version: z.string() }),
  createdAt: z.string(),
  repo: z.object({
    /** Root (parentless) commit shas — the repo identity fingerprint. */
    rootCommits: z.array(z.string()).min(1),
    repoName: z.string(),
    branch: z.string(),
    /** HEAD sha on the source machine when the bundle was created. */
    head: z.string(),
    /** Commit the bundle applies onto — target repo should be at (or contain) this. */
    base: z.string(),
    /** Human-friendly name for base, if one was used (e.g. "origin/main"). */
    baseRef: z.string().optional(),
  }),
  contents: z.object({
    commits: z.array(
      z.object({ file: z.string(), sha: z.string(), subject: z.string() }),
    ),
    worktree: z.object({ staged: z.boolean(), unstaged: z.boolean() }),
    untracked: z.array(z.string()),
  }),
  stats: z.object({
    commits: z.number(),
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    untracked: z.number(),
  }),
  /** archive path -> sha256 hex, for every entry except manifest.json itself. */
  checksums: z.record(z.string()),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
