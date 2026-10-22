# Publishing dsh-baton to npm

Two packages, released together with one version:
- `dsh-baton-mcp` (repo root): the MCP server and CLI. It also carries `host/lib`, whose socket code the server shares. `npx -y dsh-baton-mcp setup` copies it to `~/.dsh-baton/app` and registers the server from there.
- `dsh-baton-host` (`host/`): the Harness plugin. Users add it in Harness → Plugins → Add plugin → Official npm registry → `dsh-baton-host`.

The npm name `dsh-bridge` belongs to an unrelated project. `dsh-baton`, `dsh-baton-host` and `dsh-baton-mcp` are reserved as 0.0.1 placeholders; `dsh-baton-mcp` is published from 0.3.0 on.

## Checklist

1. On `main`, clean tree, tests green:

   ```bash
   git status --short
   npm test
   ```

2. Version: set both packages at once with `node scripts/version.mjs <version>`. The server and the plugin read their version from their own `package.json`; `prepublishOnly` refuses to publish when the two differ.

3. Check the contents:

   ```bash
   npm pack --dry-run
   ```

   Expect 18 files, about 46 kB packed and 133 kB unpacked:

   ```
   LICENSE  README.md  README.zh-CN.md  WINDOWS.md  package.json
   host/LICENSE  host/README.md  host/cordis.patch.yml  host/package.json
   host/lib/client.js  host/lib/index.js  host/lib/socket.js
   patches/account.patch.yml
   src/bin.mjs  src/cli.mjs  src/core.mjs  src/server.mjs  src/setup.mjs
   ```

   No `tests/`, `assets/`, `docs/` or `demo/`.

   And `(cd host && npm pack --dry-run)`: 7 files (`lib/client.js`, `lib/index.js`, `lib/socket.js`, `cordis.patch.yml`, `package.json`, `README.md`, `LICENSE`).

4. Optional dry run of the real flow from the tarball, in a throwaway config:

   ```bash
   npm pack
   CLAUDE_CONFIG_DIR=/tmp/dshb/claude CODEX_HOME=/tmp/dshb/codex DSH_BATON_HOME=/tmp/dshb/bridge \
     npx -y --package=./dsh-baton-mcp-<version>.tgz dsh-baton-mcp setup
   ```

   Create `/tmp/dshb/codex` first, or setup skips Codex. `npx ./file.tgz` does not work: the tarball goes in `--package`.

5. Sign in and publish (you, not an assistant):

   ```bash
   npm login
   (cd host && npm publish --access public --tag next)
   npm publish --access public --tag next
   ```

   `next` keeps users on the previous `latest` while you test: `npx -y dsh-baton-mcp@next setup`, and in Harness add `dsh-baton-host@next` (or the exact version) if the dialog accepts it. When it works, move both:

   ```bash
   npm dist-tag add dsh-baton-host@<version> latest
   npm dist-tag add dsh-baton-mcp@<version> latest
   ```

6. Check from a clean shell:

   ```bash
   npm view dsh-baton-mcp dist-tags
   npm view dsh-baton-host dist-tags
   npx -y dsh-baton-mcp setup
   ```

7. Tag the release:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```
