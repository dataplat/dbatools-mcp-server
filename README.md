# dbatools-mcp-server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the [dbatools](https://dbatools.io) PowerShell module.

Exposes dbatools commands as MCP tools so AI assistants (GitHub Copilot, Claude, etc.) can discover, explain, and execute dbatools commands directly — with all metadata sourced from dbatools' own **comment-based help**.

---

## Features

- **`list_dbatools_commands`** — search commands by verb, noun, keyword, or risk level
- **`get_dbatools_command_help`** — full normalized help (synopsis, parameters, examples) from `Get-Help -Full`
- **`invoke_dbatools_command`** — execute any dbatools command with safe parameter validation, risk gating, and structured JSON output
- **`check_dbatools_environment`** — verify PowerShell + dbatools installation, index freshness, and version alignment
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
│   ├── server.ts          # MCP server entry point, tool definitions
│   ├── powershell.ts      # PowerShell process runner, health checks, version detection
│   ├── help-indexer.ts    # Help manifest loader and command search
│   ├── tool-registry.ts   # Risk classification, safe argument builder
│   └── types.ts           # Shared TypeScript interfaces
├── scripts/
│   └── refresh-help.ps1   # Generates generated/dbatools-help.json
├── generated/             # Help index (gitignored, generated locally)
├── .vscode/
│   └── mcp.json           # VS Code MCP local server registration
└── dist/                  # Compiled output (gitignored)
```

---

## Contributing

Contributions are welcome! Please open an issue first for significant changes.

This project follows the same community spirit as [dbatools](https://github.com/dataplat/dbatools).

---

## License

[MIT](LICENSE) — © 2026 DataPlat contributors
