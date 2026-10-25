# Publishing dsh-baton to npm

Two packages, released together with one version:
- `dsh-baton-mcp` (repo root): the MCP server and CLI. It also carries `host/lib`, whose socket code the server shares. `npx -y dsh-baton-mcp setup` copies it to `~/.dsh-baton/app` and registers the server from there.
- `dsh-baton-host` (`host/`): the Harness plugin. Users add it in Harness → Plugins → Add plugin → `dsh-baton-host`. It depends on exactly the same version of `dsh-baton-mcp`, and switched on, copies that to `~/.dsh-baton/app` and registers it (`src/register.mjs`). So `dsh-baton-mcp` must be on npm before anyone installs the plugin: the workflow publishes it first.

The npm name `dsh-bridge` belongs to an unrelated project. `dsh-baton`, `dsh-baton-host` and `dsh-baton-mcp` are reserved as 0.0.1 placeholders; `dsh-baton-mcp` is published from 0.3.0 on.

## Checklist

1. On `main`, clean tree, tests green:

   ```bash
   git status --short
   npm test
   ```

2. Version: `node scripts/version.mjs <version>` sets both packages, the plugin's dependency on `dsh-baton-mcp` and `server.json`. The server and the plugin read their version from their own `package.json`; `prepublishOnly` refuses to publish when any of them differ.

3. Check the contents:

   ```bash
   npm pack --dry-run
   ```

   Expect 20 files, about 56 kB packed and 163 kB unpacked:

   ```
   LICENSE  README.md  README.zh-CN.md  WINDOWS.md  package.json  server.json
   host/LICENSE  host/README.md  host/cordis.patch.yml  host/package.json
   host/lib/client.js  host/lib/index.js  host/lib/socket.js
   patches/account.patch.yml
   src/bin.mjs  src/cli.mjs  src/core.mjs  src/register.mjs  src/server.mjs  src/setup.mjs
   ```

   No `tests/`, `assets/`, `docs/` or `demo/`.

   And `(cd host && npm pack --dry-run)`: 7 files (`lib/client.js`, `lib/index.js`, `lib/socket.js`, `cordis.patch.yml`, `package.json`, `README.md`, `LICENSE`).

4. Optional: try the plugin as npm will install it, before publishing. Unpack both tarballs into one folder and add that folder in Harness (Add plugin → paste the path):

   ```bash
   npm pack && (cd host && npm pack --pack-destination ..)
   mkdir -p /tmp/dshb-plugin/node_modules/dsh-baton-mcp
   tar -xzf dsh-baton-host-<version>.tgz -C /tmp/dshb-plugin --strip-components=1
   tar -xzf dsh-baton-mcp-<version>.tgz -C /tmp/dshb-plugin/node_modules/dsh-baton-mcp --strip-components=1
   ```

   Switched on, it should say it registered Claude Code and Codex, and the entries should point to `~/.dsh-baton/app/src/server.mjs`.

   And a dry run of `setup` from the tarball, in a throwaway config:

   ```bash
   npm pack
   CLAUDE_CONFIG_DIR=/tmp/dshb/claude CODEX_HOME=/tmp/dshb/codex DSH_BATON_HOME=/tmp/dshb/bridge \
     npx -y --package=./dsh-baton-mcp-<version>.tgz dsh-baton-mcp setup
   ```

   Create `/tmp/dshb/codex` first, or setup skips Codex. `npx ./file.tgz` does not work: the tarball goes in `--package`.

5. Publish by pushing a tag. `.github/workflows/release.yml` runs the tests, checks the tag against both versions and publishes both packages, with no token and no one-time password:

   ```bash
   git commit -am "<version>"
   git tag v<version>
   git push && git push origin v<version>
   ```

   A plain version (`v0.4.1`) goes to `latest`. A pre-release (`v0.5.0-next.0`) goes to `next`, for trying a release before users get it: `npx -y dsh-baton-mcp@next setup`, and in Harness the exact version, `dsh-baton-host@0.5.0-next.0`: Harness resolves the tag `@next` to a broken placeholder tarball (`0.0.0-stage`, "Unexpected end of TAR archive") and drops the plugin. To hand a version already tried under `next` to everyone, push its plain tag (`v0.4.0` for 0.4.0): the workflow sees it is published and moves `latest` to it instead of publishing again. This needs the Trusted Publisher to allow managing dist-tags (Allowed actions).

   Watch the run under the repo's **Actions** tab.

6. Check:

   ```bash
   npm view dsh-baton-mcp dist-tags
   npm view dsh-baton-host dist-tags
   npx -y dsh-baton-mcp setup
   ```

## One-time setup: Trusted Publishing

npm accepts the workflow's publishes once each package trusts it. On npmjs.com, signed in, for **both** `dsh-baton-mcp` and `dsh-baton-host`:

1. Package page → **Settings** → **Trusted Publisher** → **GitHub Actions**.
2. Organization or user: `JialaoLiu`. Repository: `dsh-baton`. Workflow filename: `release.yml`. Environment: leave empty. Allowed actions: publish directly and manage dist-tags.
3. Save.

Optional, once the workflow has published successfully: in the same Settings, under **Publishing access**, choose "Require two-factor authentication and disallow tokens". Trusted Publishing keeps working, and nothing else can publish without your one-time password.

Publishing by hand still works: `npm login`, then `npm publish --access public` and `(cd host && npm publish --access public)`, in that order, each asking for a one-time password.

## MCP Registry

`server.json` lists `dsh-baton-mcp` in the official MCP Registry as `io.github.JialaoLiu/dsh-baton` (the namespace is case-sensitive); the registry checks that the npm package's `mcpName` matches.

The release workflow does this by itself for a plain version, after npm: it signs in with `mcp-publisher login github-oidc` (GitHub's OIDC token for this repo proves the `io.github.JialaoLiu/` namespace, through `id-token: write`) and runs `mcp-publisher publish`, retrying for a few minutes while npm catches up. A version already listed is skipped. Pre-releases are not listed. `mcp-publisher` is pinned to v1.8.1 and checked against its published SHA-256; to update it, change both in `release.yml`.

By hand, if the workflow step fails:

```bash
brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

`login github` asks for a browser sign-in as the repo owner, and its token expires within minutes, so publish right after.
