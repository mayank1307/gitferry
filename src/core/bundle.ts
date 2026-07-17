import { strFromU8 } from "fflate";
import { type Entries, readArchive } from "./archive.js";
import { GitFerryError } from "./errors.js";
import { FORMAT_VERSION, type Manifest, ManifestSchema, sha256 } from "./manifest.js";

export interface Bundle {
  entries: Entries;
  manifest: Manifest;
}

/**
 * Read a .gitferry bundle: parse + schema-validate the manifest and verify
 * that the archive contains exactly the checksummed entries, all intact.
 */
export function readBundle(filePath: string): Bundle {
  const entries = readArchive(filePath);

  const manifestRaw = entries["manifest.json"];
  if (!manifestRaw) {
    throw new GitFerryError("bundle has no manifest.json", "is this really a .gitferry bundle?");
  }
  let manifest: Manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(strFromU8(manifestRaw)));
  } catch (e) {
    throw new GitFerryError(`invalid bundle manifest: ${(e as Error).message}`);
  }
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new GitFerryError(
      `bundle format v${manifest.formatVersion} is newer than this tool understands (v${FORMAT_VERSION})`,
      "upgrade gitferry on this machine",
    );
  }

  // Exact entry set match: no missing, no extras.
  const expected = new Set(Object.keys(manifest.checksums));
  for (const name of Object.keys(entries)) {
    if (name === "manifest.json") continue;
    if (!expected.has(name)) {
      throw new GitFerryError(`unexpected file in bundle: ${name}`, "bundle may have been tampered with");
    }
  }
  for (const name of expected) {
    const data = entries[name];
    if (!data) {
      throw new GitFerryError(`bundle is missing file: ${name}`, "bundle may be truncated or tampered with");
    }
    if (sha256(data) !== manifest.checksums[name]) {
      throw new GitFerryError(`checksum mismatch for ${name}`, "bundle is corrupted or was tampered with — re-create it on the source machine");
    }
  }

  return { entries, manifest };
}
