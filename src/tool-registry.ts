import type { DbatoolsCommandHelp } from "./types.js";

const READONLY_VERBS = new Set([
  "Get", "Test", "Find", "Measure", "Select", "Show",
  "Watch", "Compare", "Search", "Resolve",
]);

const DESTRUCTIVE_VERBS = new Set([
  "Remove", "Drop", "Delete", "Uninstall", "Revoke", "Disable", "Reset",
]);

/**
 * Classify a dbatools command into a risk tier based on its verb.
 * readonly  — safe to run without confirmation
 * change    — modifies state but is reversible
 * destructive — data loss risk; blocked by safe mode until confirm:true
 */
export function classifyCommand(
  name: string
): "readonly" | "change" | "destructive" {
  const verb = name.split("-")[0] ?? "";
  if (READONLY_VERBS.has(verb)) return "readonly";
  if (DESTRUCTIVE_VERBS.has(verb)) return "destructive";
  return "change";
}

/**
 * Credential descriptor accepted in the `parameters` map under the key `SqlCredential`.
 * Pass as: { "SqlCredential": { "username": "sa", "password": "secret" } }
 */
export interface SqlCredentialDescriptor {
  username: string;
  password: string;
}

function isSqlCredentialDescriptor(v: unknown): v is SqlCredentialDescriptor {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["username"] === "string" &&
    typeof (v as Record<string, unknown>)["password"] === "string"
  );
}

/**
 * Build a self-contained PowerShell script that imports dbatools, invokes the
 * requested command with the supplied parameters, and emits JSON via
 * ConvertTo-Json so the MCP server gets structured output.
 *
 * String values are single-quoted and internal single-quotes are escaped.
 * Switch parameters are passed as bare flags when value is true.
 *
 * Special parameter: SqlCredential — accepts { username, password } and is
 * converted into a PSCredential object so SQL authentication works.
 */
export function buildPowerShellScript(
  commandName: string,
  args: Record<string, unknown>,
  maxRows: number,
  selectProperties?: string[]
): string {
  // Validate command name against an allowlist pattern (letters, digits, hyphens only)
  if (!/^[A-Za-z]+-[A-Za-z][A-Za-z0-9]*$/.test(commandName)) {
    throw new Error(`Invalid command name: ${commandName}`);
  }

  // Validate selectProperties names (letters, digits only)
  if (selectProperties) {
    for (const prop of selectProperties) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prop)) {
        throw new Error(`Invalid property name: ${prop}`);
      }
    }
  }

  const preambleLines: string[] = [];
  const splatEntries: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    // Validate parameter key (letters, digits only)
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new Error(`Invalid parameter name: ${key}`);
    }
    if (value === null || value === undefined) continue;

    // Special case: SqlCredential object → build a PSCredential in the script
    if (key === "SqlCredential" && isSqlCredentialDescriptor(value)) {
      const escapedUser = value.username.replace(/'/g, "''");
      const escapedPass = value.password.replace(/'/g, "''");
      preambleLines.push(
        `$__securePass = ConvertTo-SecureString '${escapedPass}' -AsPlainText -Force`,
        `$__cred = New-Object System.Management.Automation.PSCredential('${escapedUser}', $__securePass)`
      );
      splatEntries.push(`    SqlCredential = $__cred`);
      continue;
    }

    if (typeof value === "boolean") {
      if (value) splatEntries.push(`    ${key} = $true`);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`Non-finite number for -${key}`);
      splatEntries.push(`    ${key} = ${value}`);
    } else {
      // Sanitize string: escape embedded single-quotes
      const escaped = String(value).replace(/'/g, "''");
      splatEntries.push(`    ${key} = '${escaped}'`);
    }
  }

  const splatBlock =
    splatEntries.length > 0
      ? [`$params = @{`, ...splatEntries, `}`].join("\n")
      : `$params = @{}`;

  return [
    `Set-StrictMode -Off`,
    `$ErrorActionPreference = 'Stop'`,
    `Import-Module dbatools -ErrorAction Stop`,
    ...preambleLines,
    splatBlock,
    ...(selectProperties
      ? [`$result = ${commandName} @params | Select-Object -First ${maxRows} -Property ${selectProperties.join(', ')}`]
      : [`$result = ${commandName} @params | Select-Object -First ${maxRows}`]),
    `if ($null -eq $result) { Write-Output '[]'; exit 0 }`,
    `$result | ConvertTo-Json -Depth 5 -Compress`,
  ].join("\n");
}

/**
 * Format a DbatoolsCommandHelp record into a concise MCP tool description
 * (≤ 1024 chars, which is the MCP spec recommendation).
 */
export function buildToolDescription(cmd: DbatoolsCommandHelp): string {
  const base = cmd.synopsis || cmd.description || cmd.name;
  const risk =
    cmd.riskLevel === "readonly"
      ? ""
      : ` [${cmd.riskLevel.toUpperCase()} — requires confirm:true]`;
  const full = `${base}${risk}`;
  return full.length > 1024 ? full.substring(0, 1021) + "..." : full;
}
