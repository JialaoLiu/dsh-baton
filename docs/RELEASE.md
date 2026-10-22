# Publishing dsh-baton-mcp to npm

One package, `dsh-baton-mcp`, carries both halves: the MCP server and CLI (`src/`) and the Harness plugin (`host/`). `npx -y dsh-baton-mcp setup` copies them to `~/.dsh-baton/app`, registers the server from there and puts `~/.dsh-baton/app/host` on the clipboard for Harness → Plugins → Add plugin. `dsh-baton-host` is not published on its own: Harness installs plugins from a local folder, so a separate package would add nothing.

The npm name `dsh-bridge` belongs to an unrelated project. `dsh-baton`, `dsh-baton-host` and `dsh-baton-mcp` are reserved as 0.0.1 placeholders; `dsh-baton-mcp` is published from 0.3.0 on.

## Checklist

1. On `main`, clean tree, tests green:

   ```bash
   git status --short
   npm test
   ```

2. Version: `package.json`, `host/package.json`, `host/lib/index.js` (`VERSION`) and `src/server.mjs` (`SERVER.version`) all carry the same version.

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
   npm publish --access public
   ```

6. Check from a clean shell:

   ```bash
   npm view dsh-baton-mcp version
   npx -y dsh-baton-mcp setup
   ```

7. Tag the release:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```
