# dbatools-mcp-server

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP_Server-0098FF?style=for-the-badge&logo=visualstudiocode)](https://insiders.vscode.dev/redirect/mcp/install?name=dbatools&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22dbatools-mcp-server%40latest%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP_Server-24bfa5?style=for-the-badge&logo=visualstudiocode)](https://insiders.vscode.dev/redirect/mcp/install?name=dbatools&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22dbatools-mcp-server%40latest%22%5D%7D&quality=insiders)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the [dbatools](https://dbatools.io) PowerShell module.

Exposes dbatools commands as MCP tools so AI assistants (GitHub Copilot, Claude, etc.) can discover, explain, and execute dbatools commands directly — with all metadata sourced from dbatools' own **comment-based help**.

---

## Features

- **`list_dbatools_commands`** — search commands by verb, noun, keyword, or risk level
- **`get_dbatools_command_help`** — full normalized help (synopsis, parameters, examples) from `Get-Help -Full`
- **`invoke_dbatools_command`** — execute any dbatools command with safe parameter validation, risk gating, and structured JSON output
- **`check_dbatools_environment`** — verify PowerShell + dbatools installation, index freshness, and version alignment
- **Tool annotations** — each tool declares `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` so MCP clients (e.g. VS Code) can surface risk in the UI before a tool is even called
- **Resources** — browse `dbatools://command/{name}` to read any command's full normalized help as structured JSON, independent of the chat-oriented tool responses
- **Persistent PowerShell session** — `invoke_dbatools_command` reuses one long-lived `pwsh` process with dbatools pre-imported instead of spawning (and re-importing dbatools into) a fresh process on every call
- **Version mismatch detection** — warns when installed dbatools version differs from the indexed version
- **Safe mode** — non-readonly commands require explicit `confirm: true` to execute
- **SQL Authentication support** — pass `SqlCredential: { username, password }` for SQL auth instances

---

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [PowerShell 7+](https://github.com/PowerShell/PowerShell/releases) (`pwsh`)
- [dbatools](https://dbatools.io/download) PowerShell module

```powershell
Install-Module dbatools -Scope CurrentUser
```

---

## Quick Start

```powershell
# 1. Clone the repo
git clone https://github.com/Dataplat/dbatools-mcp-server.git
cd dbatools-mcp-server

# 2. Install Node dependencies
npm install

# 3. Generate the help index from your local dbatools installation
npm run refresh-help

# 4. Build
npm run build
```

Then open the folder in VS Code — the `.vscode/mcp.json` file automatically registers the MCP server.

---

## Connecting to VS Code

The included [`.vscode/mcp.json`](.vscode/mcp.json) registers the server as a local STDIO MCP server.
Open this folder in VS Code and the server will appear in the GitHub Copilot MCP panel.

```json
{
  "servers": {
    "dbatools": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/server.js"],
      "env": {
        "DBATOOLS_SAFE_MODE": "true",
        "MAX_OUTPUT_ROWS": "100",
        "COMMAND_TIMEOUT_SECONDS": "60"
      }
    }
  }
}
```

---

## Configuration

All settings are controlled via environment variables (set in `.vscode/mcp.json` or your shell):

| Variable | Default | Description |
|---|---|---|
| `PWSH_EXE` | `pwsh` | Path to PowerShell executable |
| `DBATOOLS_SAFE_MODE` | `true` | When `true`, non-readonly commands require `confirm: true` |
| `MAX_OUTPUT_ROWS` | `100` | Maximum rows returned per command execution |
| `COMMAND_TIMEOUT_SECONDS` | `60` | Seconds before PowerShell process is killed |
| `DBATOOLS_PERSISTENT_SESSION` | `true` | When `true`, `invoke_dbatools_command` reuses one long-lived PowerShell process (dbatools pre-imported) instead of spawning a new process per call. Set to `false` to force a fresh process per call. |

---

## Refreshing the Help Index

The help index (`generated/dbatools-help.json`) is generated from your locally installed dbatools module.
Re-run whenever dbatools is updated:

```powershell
Update-Module dbatools -Scope CurrentUser
npm run refresh-help
```

The server detects version mismatches at runtime and warns you when the index is stale.

---

## Risk Levels

Commands are automatically classified by verb:

| Risk Level | Verbs | Behavior |
|---|---|---|
| `readonly` | Get, Test, Find, Compare, … | Always allowed |
| `change` | Set, New, Add, Copy, Enable, … | Requires `confirm: true` in safe mode |
| `destructive` | Remove, Drop, Disable, Reset, … | Requires `confirm: true` in safe mode |

Each risk tier maps to standard MCP [tool annotations](https://modelcontextprotocol.io/specification/server/tools#annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so compatible clients can surface risk in their UI before a tool is even invoked. `invoke_dbatools_command` is a generic dispatcher that can run any command, so its annotation conservatively reflects the worst case (`destructiveHint: true`) — the actual per-command risk is still enforced at runtime by the safe-mode gate.

---

## Resources

Besides the four tools, the server exposes every indexed command as an MCP resource at `dbatools://command/{name}` (e.g. `dbatools://command/Get-DbaDatabase`), returning the same normalized help record as structured JSON — useful for clients that browse/ground on resources rather than calling a tool. The browsable resource list excludes PowerShell aliases (e.g. `Attach-DbaDatabase`, an alias for `Mount-DbaDatabase`) since they just forward to another command's help.

---

## Persistent PowerShell Session

By default, `invoke_dbatools_command` reuses a single long-lived `pwsh` process with dbatools pre-imported, instead of spawning a fresh process (and re-importing dbatools) on every call. This removes the ~1-2s+ process-startup and module-import cost from every invocation after the first.

A couple of things to be aware of:

- **Crash/timeout recovery**: if a command times out or the session process crashes, it is killed and discarded; the next call transparently starts a fresh session (paying the import cost once more). The call that triggered the failure is not automatically retried.
- **Cross-call state**: dbatools caches some state (e.g. SMO connections via `Connect-DbaInstance`) within a PowerShell session. With a persistent session, that caching is now visible across tool calls within one MCP server run, where previously every call was fully isolated. Each individual script still runs in its own scope, so plain variables never leak between calls — only dbatools' own internal caching behavior is affected.

Set `DBATOOLS_PERSISTENT_SESSION=false` to disable this and go back to one fresh process per call.

---

## SQL Authentication

For SQL-auth-only instances (e.g. Docker), pass credentials via the `SqlCredential` parameter:

```json
{
  "SqlInstance": "localhost,1433",
  "SqlCredential": { "username": "<SqlLogin>", "password": "YourPassword" }
}
```

---

## Project Structure

```
dbatools-mcp-server/
├── src/
│   ├── server.ts              # MCP server entry point, tool/resource definitions
│   ├── powershell.ts           # One-shot PowerShell process runner, health checks, version detection
│   ├── powershell-session.ts   # Persistent PowerShell session (long-lived process, dbatools pre-imported)
│   ├── help-indexer.ts         # Help manifest loader and command search
│   ├── tool-registry.ts        # Risk classification, tool annotations, safe argument builder
│   └── types.ts                # Shared TypeScript interfaces
├── scripts/
│   └── refresh-help.ps1       # Generates generated/dbatools-help.json
├── generated/                 # Help index (gitignored, generated locally)
├── .vscode/
│   └── mcp.json               # VS Code MCP local server registration
└── dist/                      # Compiled output (gitignored)
```

---

## Contributing

Contributions are welcome! Please open an issue first for significant changes.

This project follows the same community spirit as [dbatools](https://github.com/dataplat/dbatools).

---

## License

[MIT](LICENSE) — © 2026 DataPlat contributors
