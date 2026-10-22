#!/usr/bin/env node
// The package's main bin: with no arguments it is the MCP server (what MCP clients
// start), with a command it is the CLI, so `npx dsh-baton-mcp setup` works.
await import(process.argv.length > 2 ? './cli.mjs' : './server.mjs')
