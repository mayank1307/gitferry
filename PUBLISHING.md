# Publishing GitFerry

GitFerry is distributed publicly but runs locally over stdio. There is no hosted MCP endpoint or GitFerry account requirement for users. Publishing this repository does not publish the npm package or register the MCP server automatically until the release workflow runs successfully.

## One-time maintainer setup

1. Make `https://github.com/mayank1307/gitferry` publicly accessible and confirm the maintainer has permission to release all included code under the MIT license. The unauthenticated GitHub API returned 404 on 31 October 2026, which can mean a private or nonexistent repository.
2. Sign in to npm and confirm that the name `gitferry` can be published by your account. Its public registry endpoint returned 404 on 31 October 2026; this is not a name reservation or proof of account ownership. If a scoped name is needed, update package.json, package-lock.json, server.json, scripts, and installation examples consistently before publishing.
3. Enable two-factor authentication on the npm maintainer account. For the first package publication, use the bootstrap procedure below if npm requires an existing package before configuring trusted publishing.
4. In npm package settings, add a GitHub trusted publisher: owner `mayank1307`, repository `gitferry`, workflow `release.yml`, environment `release`. Enable direct `npm publish` for that publisher. No npm write token is needed by the workflow.
5. Create the GitHub environment `release` and limit it to reviewed version tags; configure reviewers if your organization requires them. Protect the default branch and release tags. Ensure Actions may request OIDC tokens and create releases.
6. Enable GitHub private vulnerability reporting as described in SECURITY.md.

The registry name is `io.github.mayank1307/gitferry`. GitHub OIDC supplies registry namespace ownership in Actions. The `mcpName` field must match server.json before the npm artifact is published.

## Verify a candidate locally

Use Node 22 or 24 and Git >=2.32:

```bash
npm ci
npm run release:check
npm audit --audit-level=low
npm run release:artifacts
```

`release:check` validates the vendored official registry schema and all version locations, builds from a clean dist directory, runs tests, packs the actual npm artifact, installs it in an isolated temporary project, and connects to every shipped MCP entry point. The package smoke check downloads production dependencies from npm and requires network access. It cleans up its temporary directory.

`release:artifacts` produces `release/gitferry-0.4.0.tgz`, `release/gitferry.cjs`, `release/gitferry-mcp.cjs`, `release/server.json`, and SHA256SUMS. It does not publish. Verify the checksums from inside release/ using `shasum -a 256 -c SHA256SUMS` (macOS) or `sha256sum -c SHA256SUMS` (Linux).

Review the intended diff, ensure clean-machine CI passes on all six Node/OS combinations, and try DEMO.md before release. Keep unrelated existing work out of the release commit. Local execution on one OS does not establish cross-platform success.

## First npm publication, if required

An npm trusted publisher may require an already existing package. After all checks pass, authenticate interactively with `npm login` and publish the exact tarball:

```bash
npm publish ./release/gitferry-0.4.0.tgz --access public
```

This command publishes publicly and cannot reuse an existing version. Then configure trusted publishing before tagging. The release workflow verifies an already published version's tarball integrity and `mcpName`; it only skips npm publication when both match the freshly built tagged candidate. If the bootstrap artifact differs, publish a new version rather than trying to overwrite it. A manual bootstrap does not receive automatic GitHub OIDC provenance; future public-repository workflow releases do.

## Versioned release

1. Update package.json, package-lock.json, src/version.ts, server.json, pinned installation examples, and CHANGELOG.md together. `npm run check:release` catches version mismatches in executable/registry metadata. Choose an unused npm version.
2. Commit the reviewed release candidate, tag that commit `v0.4.0`, and push the commit and tag when ready to publish. A version tag triggers `.github/workflows/release.yml`.
3. The workflow validates every supported OS/Node combination, builds artifacts, publishes npm through OIDC, verifies the public tarball, publishes MCP Registry metadata through GitHub OIDC, and creates a GitHub release with offline assets and SHA256SUMS.
4. Verify `https://registry.npmjs.org/gitferry/0.4.0`, the official MCP Registry record, and installation from a clean machine. The registry package uses the standard npm resolver plus `mcp` argument, so it launches the MCP server rather than the interactive CLI.

The publishing job uses Node 24, npm 12.2.1, and mcp-publisher 1.8.7 with a pinned Linux binary SHA-256. GitHub Actions dependencies are pinned to commits. Review and update these deliberately. The official schema snapshot lives under scripts/schemas/ for offline metadata validation.

## Retrying and recovery

If npm succeeded but the registry or GitHub release step failed, use **Run workflow** on Publish GitFerry with the same existing tag. The workflow verifies the public npm tarball matches the rebuilt candidate before continuing. It refuses a version whose artifact differs. An identical existing registry record is also verified and skipped. Existing GitHub assets are compared before missing assets are uploaded; differing bytes fail rather than overwrite released files.

For a defective release, deprecate the affected npm version with a message naming the last good version, update installation examples if needed, and release a fix under a new version. Preserve released artifacts and tags. Never replace a version with different bytes.

Registry discoverability does not guarantee placement in individual client directories. Submit directory listings separately after the npm and registry checks pass.

## Official references

- [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)
- [Registry GitHub Actions publishing](https://modelcontextprotocol.io/registry/github-actions)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
