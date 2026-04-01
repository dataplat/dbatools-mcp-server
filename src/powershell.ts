import { spawn } from "child_process";
import type { PowerShellResult, ServerConfig } from "./types.js";

/** Maximum total stdout+stderr bytes buffered per PowerShell invocation (10 MB). */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Parse an integer env var, falling back to `defaultVal` when the value is
 * missing, non-numeric, or outside the given bounds.
 */
function parseIntEnv(
  key: string,
  defaultVal: number,
  min: number,
  max: number
): number {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return defaultVal;
  return parsed;
}

/**
 * Resolve runtime configuration from environment variables with safe defaults.
 * All values can be overridden without code changes.
 */
export function getConfig(): ServerConfig {
  return {
    powershellExe: process.env["PWSH_EXE"] ?? "pwsh",
    safeMode: process.env["DBATOOLS_SAFE_MODE"] !== "false",
    maxOutputRows: parseIntEnv("MAX_OUTPUT_ROWS", 100, 1, 10_000),
    commandTimeout: parseIntEnv("COMMAND_TIMEOUT_SECONDS", 60, 5, 3600),
  };
}

/**
 * Spawn a PowerShell process, run the given script, and collect stdout/stderr.
 * Rejects only on process spawn failure; non-zero exit codes are resolved normally
 * so the caller can inspect exitCode and stderr.
 */
export function runPowerShell(
  script: string,
  config: ServerConfig
): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    // Encode the script as Base64 UTF-16LE and use -EncodedCommand so that
    // no part of the script (including any user-supplied parameter values
    // embedded in it) is ever parsed as a command-line argument by PowerShell.
    // This eliminates the command-injection risk present with -Command.
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    const pwsh = spawn(
      config.powershellExe,
      [
        "-NonInteractive",
        "-NoProfile",
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      { shell: false }
    );

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let settled = false;

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      pwsh.kill("SIGKILL");
      reject(err);
    }

    const timer = setTimeout(() => {
      fail(new Error(`PowerShell process timed out after ${config.commandTimeout}s`));
    }, config.commandTimeout * 1000);

    pwsh.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BUFFER_BYTES) {
        clearTimeout(timer);
        fail(new Error(`PowerShell output exceeded the ${MAX_BUFFER_BYTES / 1024 / 1024} MB safety limit`));
        return;
      }
      stdout += chunk.toString();
    });

    pwsh.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BUFFER_BYTES) {
        clearTimeout(timer);
        fail(new Error(`PowerShell output exceeded the ${MAX_BUFFER_BYTES / 1024 / 1024} MB safety limit`));
        return;
      }
      stderr += chunk.toString();
    });

    pwsh.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    pwsh.on("error", (err) => {
      clearTimeout(timer);
      fail(new Error(`Failed to launch '${config.powershellExe}': ${err.message}`));
    });
  });
}

/**
 * Quick health-check: verifies that PowerShell and the dbatools module are
 * available on the current machine.
 */
export async function checkDbatools(
  config: ServerConfig
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const result = await runPowerShell(
      `$m = Get-Module -ListAvailable -Name dbatools | ` +
        `Sort-Object Version -Descending | Select-Object -First 1; ` +
        `if ($m) { Write-Output $m.Version.ToString() } else { exit 1 }`,
      config
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { ok: true, version: result.stdout.trim() };
    }
    return {
      ok: false,
      error:
        "dbatools module not found. Install it with: Install-Module dbatools -Scope CurrentUser",
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface VersionMismatchResult {
  installedVersion: string;
  indexedVersion: string;
  isStale: boolean;
  message: string;
}

/**
 * Compare the installed dbatools version against the version stored in the
 * help-index manifest. Returns a structured result with a human-readable
 * warning when the two differ.
 */
export async function checkVersionMismatch(
  config: ServerConfig,
  indexedVersion: string
): Promise<VersionMismatchResult> {
  const check = await checkDbatools(config);

  if (!check.ok || !check.version) {
    return {
      installedVersion: "unknown",
      indexedVersion,
      isStale: false,
      message: check.error ?? "Could not determine installed dbatools version.",
    };
  }

  const installed = check.version.trim();
  const isStale = installed !== indexedVersion;

  const message = isStale
    ? `⚠️  dbatools version mismatch detected!\n` +
      `   Installed : ${installed}\n` +
      `   Index     : ${indexedVersion}\n` +
      `   The help index is stale. Run 'npm run refresh-help' to rebuild it.\n` +
      `   Until then, command metadata may be inaccurate for new/changed commands.`
    : `✅ dbatools version matches index (${installed}).`;

  return { installedVersion: installed, indexedVersion, isStale, message };
}
