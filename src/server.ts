import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadHelpIndex, loadHelpManifest, searchCommands } from "./help-indexer.js";
import { runPowerShell, checkDbatools, getConfig, checkVersionMismatch, type VersionMismatchResult } from "./powershell.js";
import {
  classifyCommand,
  buildPowerShellScript,
  buildToolDescription,
} from "./tool-registry.js";

const config = getConfig();

// Version mismatch state — resolved once at startup, reused by tools
let versionState: VersionMismatchResult | null = null;

async function getVersionState(): Promise<VersionMismatchResult> {
  if (versionState) return versionState;
  try {
    const manifest = loadHelpManifest();
    versionState = await checkVersionMismatch(config, manifest.dbatoolsVersion);
  } catch {
    versionState = {
      installedVersion: "unknown",
      indexedVersion: "unknown",
      isStale: false,
      message: "Help index not yet generated — run 'npm run refresh-help'.",
    };
  }
  return versionState;
}

const server = new McpServer({
  name: "dbatools-mcp-server",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: list_dbatools_commands
// ---------------------------------------------------------------------------
server.tool(
  "list_dbatools_commands",
  "Search and list dbatools commands. Filter by verb, noun, keyword, or risk level.",
  {
    verb: z
      .string()
      .max(50)
      .optional()
      .describe("PowerShell verb (e.g. Get, Set, New, Remove, Test)"),
    noun: z
      .string()
      .max(100)
      .optional()
      .describe("Noun fragment to match (e.g. Database, Login, AgentJob)"),
    keyword: z
      .string()
      .max(200)
      .optional()
      .describe("Keyword to search in name, synopsis, and description"),
    riskLevel: z
      .enum(["readonly", "change", "destructive"])
      .optional()
      .describe("Filter by risk tier"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of results (default 50, max 200)"),
  },
  async ({ verb, noun, keyword, riskLevel, limit }) => {
    const vs = await getVersionState();
    const stalePrefix = vs.isStale ? vs.message + "\n\n" : "";

    let index;
    try {
      index = loadHelpIndex();
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Help index unavailable: ${String(e)}` }], isError: true };
    }
    const results = searchCommands(index, { verb, noun, keyword, riskLevel, limit });

    if (results.length === 0) {
      return {
        content: [
          { type: "text", text: stalePrefix + "No commands found matching the given filters." },
        ],
      };
    }

    const header = `Found ${results.length} command(s):\n`;
    const rows = results
      .map(
        (c) =>
          `${c.name.padEnd(50)} [${c.riskLevel.padEnd(11)}]  ${(c.synopsis ?? "").substring(0, 80)}`
      )
      .join("\n");

    return { content: [{ type: "text", text: stalePrefix + header + rows }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_dbatools_command_help
// ---------------------------------------------------------------------------
server.tool(
  "get_dbatools_command_help",
  "Get the full normalized help for a specific dbatools command, including parameters and examples sourced from comment-based help.",
  {
    commandName: z
      .string()
      .max(100)
      .describe("Exact command name, e.g. Get-DbaDatabase"),
  },
  async ({ commandName }) => {
    const vs = await getVersionState();
    const stalePrefix = vs.isStale ? vs.message + "\n\n" : "";

    let index;
    try {
      index = loadHelpIndex();
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Help index unavailable: ${String(e)}` }], isError: true };
    }
    const help = index[commandName];

    if (!help) {
      return {
        content: [
          {
            type: "text",
            text:
              stalePrefix +
              `Command '${commandName}' not found in the help index.\n` +
              `Use list_dbatools_commands to discover available commands.`,
          },
        ],
        isError: true,
      };
    }

    const paramLines =
      help.parameters.length === 0
        ? "  (none documented)"
        : help.parameters
            .map((p) => {
              const req = p.required ? " [REQUIRED]" : "";
              const aliases =
                p.aliases.length > 0
                  ? `  aliases: ${p.aliases.join(", ")}`
                  : "";
              const pipeline = p.pipelineInput ? "  pipeline input: yes" : "";
              return (
                `  -${p.name} <${p.type}>${req}` +
                `${aliases}${pipeline}\n    ${p.description || "(no description)"}`
              );
            })
            .join("\n\n");

    const exampleLines =
      help.examples.length === 0
        ? "  (none documented)"
        : help.examples
            .slice(0, 5)
            .map(
              (ex, i) =>
                `--- Example ${i + 1}${ex.title ? ": " + ex.title : ""} ---\n` +
                `${ex.code}\n` +
                (ex.remarks ? `Remarks: ${ex.remarks}` : "")
            )
            .join("\n\n");

    const text = [
      `NAME:        ${help.name}`,
      `RISK LEVEL:  ${help.riskLevel}`,
      `VERB / NOUN: ${help.verb} / ${help.noun}`,
      ``,
      `SYNOPSIS`,
      `--------`,
      help.synopsis || "(none)",
      ``,
      `DESCRIPTION`,
      `-----------`,
      help.description || "(none)",
      ``,
      `PARAMETERS`,
      `----------`,
      paramLines,
      ``,
      `EXAMPLES`,
      `--------`,
      exampleLines,
      help.relatedLinks.length > 0
        ? `\nRELATED LINKS\n-------------\n${help.relatedLinks.join("\n")}`
        : "",
    ]
      .join("\n")
      .trim();

    return { content: [{ type: "text", text: stalePrefix + text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: invoke_dbatools_command
// ---------------------------------------------------------------------------
server.tool(
  "invoke_dbatools_command",
  "Execute a dbatools command via PowerShell and return structured JSON output.\n\nSAFETY: For any destructive or change command (Remove, Drop, Disable, Reset, etc.), always explain the consequences to the user and ask for explicit confirmation before running. Only proceed with confirm:true if the user has clearly confirmed their intent. Respect DBATOOLS_SAFE_MODE: never bypass safety checks. For any command that modifies or deletes data, double-check with the user before proceeding. Show the exact command and output for transparency. Non-readonly commands require confirm:true when safe mode is enabled.",
  {
    commandName: z
      .string()
      .max(100)
      .describe("Exact dbatools command name to execute, e.g. Get-DbaDatabase"),
    parameters: z
      .record(z.unknown())
      .default({})
      .describe(
        "Key-value map of parameters. Strings, numbers, and booleans map directly to PowerShell parameters. " +
        "For SQL authentication pass SqlCredential as an object: { \"username\": \"sa\", \"password\": \"secret\" }. " +
        "Example: { \"SqlInstance\": \"localhost,2022\", \"SqlCredential\": { \"username\": \"sa\", \"password\": \"P@ssw0rd\" } }"
      ),
    confirm: z
      .boolean()
      .default(false)
      .describe(
        "Set to true to allow execution of change/destructive commands (required when safeMode is on)"
      ),
  },
  async ({ commandName, parameters, confirm }) => {
    let index;
    try {
      index = loadHelpIndex();
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Help index unavailable: ${String(e)}` }], isError: true };
    }
    const help = index[commandName];

    if (!help) {
      return {
        content: [
          {
            type: "text",
            text:
              `Unknown command: '${commandName}'.\n` +
              `Use list_dbatools_commands to discover available commands.`,
          },
        ],
        isError: true,
      };
    }

    // Safety gate: block non-readonly commands unless confirmed
    if (config.safeMode && help.riskLevel !== "readonly" && !confirm) {
      return {
        content: [
          {
            type: "text",
            text:
              `Command '${commandName}' has risk level '${help.riskLevel}'.\n` +
              `Set confirm: true to allow execution, or use a readonly command instead.`,
          },
        ],
        isError: true,
      };
    }

    let script: string;
    try {
      script = buildPowerShellScript(
        commandName,
        parameters as Record<string, unknown>,
        config.maxOutputRows
      );
    } catch (e) {
      return {
        content: [{ type: "text", text: `Parameter validation error: ${String(e)}` }],
        isError: true,
      };
    }

    let result;
    try {
      result = await runPowerShell(script, config);
    } catch (e) {
      return {
        content: [{ type: "text", text: `PowerShell execution failed: ${String(e)}` }],
        isError: true,
      };
    }

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `Command failed (exit ${result.exitCode}):\n` +
              (result.stderr || result.stdout || "(no output)"),
          },
        ],
        isError: true,
      };
    }

    // Try to parse structured output
    let parsed: unknown = undefined;
    const trimmed = result.stdout.trim();
    if (trimmed) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not JSON — return raw text
      }
    }

    const recordCount = Array.isArray(parsed)
      ? parsed.length
      : parsed != null
        ? 1
        : 0;

    const summary = `Executed '${commandName}' — ${recordCount} record(s) returned.`;

    const body = parsed
      ? JSON.stringify(parsed, null, 2)
      : trimmed || "(no output)";

    const stderrSection =
      result.stderr.trim() ? `\n\nSTDERR:\n${result.stderr.trim()}` : "";

    return {
      content: [
        { type: "text", text: `${summary}\n\n${body}${stderrSection}` },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: check_dbatools_environment
// ---------------------------------------------------------------------------
server.tool(
  "check_dbatools_environment",
  "Verify that PowerShell and the dbatools module are installed and report the help-index status.",
  {},
  async () => {
    const check = await checkDbatools(config);

    if (!check.ok) {
      return {
        content: [
          {
            type: "text",
            text: `dbatools not available: ${check.error}`,
          },
        ],
        isError: true,
      };
    }

    let indexInfo = "Help index: not generated yet (run 'npm run refresh-help')";
    let vsMismatch = "";
    try {
      const manifest = loadHelpManifest();
      indexInfo =
        `Help index: ${manifest.commandCount} commands indexed\n` +
        `  dbatools version in index: ${manifest.dbatoolsVersion}\n` +
        `  Generated at:              ${manifest.generatedAt}`;
      const vs = await checkVersionMismatch(config, manifest.dbatoolsVersion);
      // Invalidate cached state so next tool call re-evaluates
      versionState = vs;
      vsMismatch = vs.message;
    } catch {
      // Index missing — that's fine, non-fatal
    }

    return {
      content: [
        {
          type: "text",
          text: [
            `dbatools ${check.version} is installed and ready.`,
            indexInfo,
            vsMismatch,
            `Safe mode:       ${config.safeMode ? "ON (non-readonly commands require confirm:true)" : "OFF"}`,
            `Max output rows: ${config.maxOutputRows}`,
            `Timeout:         ${config.commandTimeout}s`,
          ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
