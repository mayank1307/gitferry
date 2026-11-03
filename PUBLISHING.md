# Publishing GitFerry

GitFerry 0.4.1 was released through GitHub Actions on 3 November 2026: [npm](https://www.npmjs.com/package/gitferry/v/0.4.1), [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mayank1307%2Fgitferry/versions/0.4.1), and [GitHub release with offline assets](https://github.com/mayank1307/gitferry/releases/tag/v0.4.1). The source repository is public. GitFerry runs locally over stdio; there is no hosted MCP endpoint or GitFerry account requirement for users.

The tagged release passed CI on Node 22/24 across Linux, macOS, and Windows. Its npm publication used the configured OIDC trusted publisher, generated signed provenance for `.github/workflows/release.yml` at `refs/tags/v0.4.1`, and changed the npm connection status to **Valid**. The [release workflow](https://github.com/mayank1307/gitferry/actions/runs/41591005748) completed npm, MCP Registry, and GitHub publication. npm processing exceeded the initial verification window; retrying the failed publishing job verified the existing immutable package and completed the remaining steps.

The initial v0.4.0 npm and MCP publications used interactive authentication. Preserve all released tags and artifacts; subsequent changes on `main` do not replace published packages.

## One-time maintainer setup

1. Keep [the source repository](https://github.com/mayank1307/gitferry) public and confirm that future contributions can be released under the MIT license.
2. Sign in to npm with an account that has publish access to the existing `gitferry` package. The initial release was published by `mayankku1307`; the MCP namespace uses the GitHub identity `mayank1307`.
3. Keep two-factor authentication enabled for npm publication. Complete any browser approval requested by the CLI. If npm stages a submission, approve the intended version through Staged Packages before verifying public availability; see [npm staged publishing](https://docs.npmjs.com/staged-publishing/).
4. Keep the configured npm trusted publisher aligned with `.github/workflows/release.yml`: owner `mayank1307`, repository `gitferry`, workflow filename `release.yml`, environment `release`, direct `npm publish` enabled. No npm write token is needed by the workflow. If these names change, update the npm trust configuration before the next release.
5. Create the GitHub environment `release` and limit it to reviewed version tags; configure reviewers if your organization requires them. Protect the default branch and release tags. Ensure Actions may request OIDC tokens and create releases.
6. Enable GitHub private vulnerability reporting as described in SECURITY.md.

The registry name is `io.github.mayank1307/gitferry`. GitHub OIDC supplies registry namespace ownership in Actions. The `mcpName` field must match server.json before the npm artifact is published.

## Configured npm trusted publisher

| Setting | Saved value |
|---------|-------------|
| Package | `gitferry` |
| Provider | GitHub Actions |
| Repository | `mayank1307/gitferry` |
| Workflow filename | `release.yml` |
| GitHub environment | `release` |
| Allowed actions | Direct publish and stage publish |
| Configuration ID | `b26ad109-b8af-4bd9-b5a9-b0a39a794063` |
| Status | Valid — verified in npm settings on 3 November 2026 |
| First OIDC publication | `gitferry@0.4.1` |

The publishing job already runs on a GitHub-hosted runner with Node 24, npm 12.2.1, `id-token: write`, and `environment: release`. When an unused version tag is pushed, the workflow runs the six-platform validation matrix, builds the release artifacts, and publishes through npm OIDC. npm issues a short-lived credential for that job; no `NPM_TOKEN` repository secret is required. Stage publication is included by npm; this workflow uses direct publication so a staged-package approval is not part of the normal release path.

To inspect the saved configuration with an npm version supporting trust commands:

```bash
npx --yes npm@11.15.0 trust list gitferry
```

If the configuration must be recreated, review any existing trust entry first, then use:

```bash
npx --yes npm@11.15.0 trust github gitferry --file release.yml --repository mayank1307/gitferry --environment release --allow-publish
```

npm may request account 2FA approval when reading or changing trust configurations. This connection completed its first publication and is validated; the initial pending-validation deadline no longer applies. A dry run or retry of an already published version verifies artifacts but does not test a new OIDC publication. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for provider requirements.

## Verify a candidate locally

Use Node 22 or 24 and Git >=2.32:

```bash
npm ci
npm run release:check
npm audit --audit-level=low
npm run release:artifacts
```

`release:check` validates the vendored official registry schema and all version locations, builds from a clean dist directory, runs tests, packs the actual npm artifact, installs it in an isolated temporary project, and connects to every shipped MCP entry point. The package smoke check downloads production dependencies from npm and requires network access. It cleans up its temporary directory.

`release:artifacts` produces `release/gitferry-0.4.1.tgz`, `release/gitferry.cjs`, `release/gitferry-mcp.cjs`, `release/server.json`, and SHA256SUMS. It does not publish. Verify the checksums from inside release/ using `shasum -a 256 -c SHA256SUMS` (macOS) or `sha256sum -c SHA256SUMS` (Linux).

Review the intended diff, ensure clean-machine CI passes on all six Node/OS combinations, and try DEMO.md before release. Keep unrelated existing work out of the release commit. Local execution on one OS does not establish cross-platform success.

## Manual publication for a future version

The first publication is complete. If a future version needs interactive publication instead of OIDC, authenticate with `npm login` and publish its exact verified tarball. Replace `X.Y.Z` with the new, unused version:

```bash
npm publish ./release/gitferry-X.Y.Z.tgz --access public
```

This command publishes publicly and cannot reuse an existing version. Then configure trusted publishing before tagging. The release workflow verifies an already published version's tarball integrity and `mcpName`; it only skips npm publication when both match the freshly built tagged candidate. If the bootstrap artifact differs, publish a new version rather than trying to overwrite it. A manual bootstrap does not receive automatic GitHub OIDC provenance; future public-repository workflow releases do.

## Versioned release

1. Update package.json, package-lock.json, src/version.ts, server.json, pinned installation examples, and CHANGELOG.md together. `npm run check:release` catches version mismatches in executable/registry metadata. Choose an unused npm version.
2. Commit the reviewed release candidate, tag that commit `vX.Y.Z` for the new version, and push the commit and tag when ready to publish. Never move or recreate `v0.4.0`. A version tag triggers `.github/workflows/release.yml`.
3. The workflow validates every supported OS/Node combination, builds artifacts, publishes npm through OIDC, verifies the public tarball, publishes MCP Registry metadata through GitHub OIDC, and creates a GitHub release with offline assets and SHA256SUMS.
4. Verify the new version at `https://registry.npmjs.org/gitferry/X.Y.Z`, its official MCP Registry record, and installation from a clean machine. The registry package uses the standard npm resolver plus `mcp` argument, so it launches the MCP server rather than the interactive CLI.

The publishing job uses Node 24, npm 12.2.1, and mcp-publisher 1.8.7 with a pinned Linux binary SHA-256. GitHub Actions dependencies are pinned to commits. Review and update these deliberately. The official schema snapshot lives under scripts/schemas/ for offline metadata validation.

## Retrying and recovery

If npm succeeded but the registry or GitHub release step failed, use **Run workflow** on Publish GitFerry with the same existing tag, using the tagged source and its exact artifacts rather than a changed `main` checkout. The workflow verifies the public npm tarball matches the rebuilt candidate before continuing. After an accepted publication, it polls public metadata for up to five minutes to accommodate npm processing; if that expires, wait for public availability and retry the same tag rather than submitting a different artifact. It refuses a version whose artifact differs. An identical existing registry record is also verified and skipped. Existing GitHub assets are compared before missing assets are uploaded; differing bytes fail rather than overwrite released files.

For a defective release, deprecate the affected npm version with a message naming the last good version, update installation examples if needed, and release a fix under a new version. Preserve released artifacts and tags. Never replace a version with different bytes.

Registry discoverability does not guarantee placement in individual client directories. Submit directory listings separately after the npm and registry checks pass.

## Official references

- [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)
- [Registry GitHub Actions publishing](https://modelcontextprotocol.io/registry/github-actions)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
