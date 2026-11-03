# Five-minute GitFerry walkthrough

Install the published version with `npm install -g gitferry@0.4.2`, or follow [INSTALL.md](INSTALL.md) for offline installation and MCP client setup.

Use disposable repositories. These shell commands work in macOS/Linux or Git Bash on Windows after installing GitFerry; replace `gitferry` with `node /absolute/path/to/gitferry.cjs` for the standalone CLI.

```bash
mkdir gitferry-demo
cd gitferry-demo
git init -b main sender
git -C sender config user.name 'Demo User'
git -C sender config user.email demo@example.com
git -C sender config commit.gpgsign false
printf 'first version\n' > sender/hello.txt
git -C sender add hello.txt
git -C sender commit -m 'Initial version'
git clone sender receiver
git -C receiver config user.name 'Demo Receiver'
git -C receiver config user.email receiver@example.com
git -C receiver config commit.gpgsign false

printf 'second version\n' > sender/hello.txt
printf 'new file\n' > sender/notes.txt
gitferry pack -C sender --only uncommitted -o ../transfer.gitferry
gitferry inspect transfer.gitferry
gitferry apply -C receiver ../transfer.gitferry --dry-run
git -C receiver status --short
gitferry apply -C receiver ../transfer.gitferry
git -C receiver status --short
```

After the dry run, receiver should remain clean. After apply, `hello.txt` is modified and `notes.txt` is untracked. Inspect both files and compare them with sender. The sender and receiver can be different machines; transfer the `.gitferry` file between pack and inspect.

For the same walkthrough through MCP, connect the local server and ask:

1. “Call pack_changes on my sender repository with only=uncommitted and write the bundle to my transfer.gitferry path.”
2. “Inspect that bundle and show the files and warnings.”
3. “Dry-run apply_bundle against my receiver repository and show the plan.”
4. After reviewing the plan: “Apply the bundle to the receiver repository.”

Provide absolute paths to the client. Use `only=repo` to create a snapshot of current tracked-file contents when seeding an empty directory; normal change bundles require shared Git history.
