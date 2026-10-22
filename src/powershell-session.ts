import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface, type Interface } from "readline";
import { randomUUID } from "crypto";

import { runPowerShell } from "./powershell.js";
import type { PowerShellResult, ServerConfig } from "./types.js";

/** Maximum bytes (post-base64-decode) accepted for a single response envelope. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** How long to wait for the one-time "ready" handshake after spawning. */
const STARTUP_TIMEOUT_MS = 30_000;
/** Sentinel id used for the startup handshake message. */
const READY_ID = "__ready__";

interface ResponseEnvelope {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PendingRequest {
  resolve: (result: PowerShellResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The PowerShell "driver" loop that runs for the lifetime of the persistent
 * session. It imports dbatools once, then reads one base64(JSON) request per
 * line from stdin and writes exactly one base64(JSON) response per line to
 * stdout, so request/response framing survives arbitrary script output
 * (including embedded newlines) without ambiguity.
 *
 * All non-success PowerShell streams (warning/verbose/debug/information) are
 * silenced and, as a second line of defense, redirected into the captured
 * output alongside the error stream — otherwise a single `Write-Warning` (or
 * similar) call from deep inside a dbatools command would be written
 * directly to the shared stdout pipe by the host and corrupt the line-based
 * protocol, since only the driver's own `[Console]::Out.WriteLine` calls are
 * meant to ever reach it.
 *
 * Each request's script runs via the call operator (`&`), which gives it its
 * own child scope — variables set inside one call (e.g. `$params`, `$result`)
 * do not leak into the session scope or into subsequent calls.
 */
const DRIVER_SCRIPT = [
  "Set-StrictMode -Off",
  "$ErrorActionPreference = 'Stop'",
  "$WarningPreference = 'SilentlyContinue'",
  "$VerbosePreference = 'SilentlyContinue'",
  "$InformationPreference = 'SilentlyContinue'",
  "$DebugPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$script:ready = $false",
  "try {",
  "    Import-Module dbatools -ErrorAction Stop",
  "    $script:ready = $true",
  "    $readyResp = @{ id = '__ready__'; stdout = 'ok'; stderr = ''; exitCode = 0 } | ConvertTo-Json -Compress",
  "} catch {",
  "    $readyResp = @{ id = '__ready__'; stdout = ''; stderr = $_.Exception.Message; exitCode = 1 } | ConvertTo-Json -Compress",
  "}",
  "$readyBytes = [System.Text.Encoding]::UTF8.GetBytes($readyResp)",
  "[Console]::Out.WriteLine([Convert]::ToBase64String($readyBytes))",
  "[Console]::Out.Flush()",
  "",
  "if (-not $script:ready) { exit 1 }",
  "",
  "while ($true) {",
  "    $line = [Console]::In.ReadLine()",
  "    if ($null -eq $line) { break }",
  "    if ([string]::IsNullOrWhiteSpace($line)) { continue }",
  "",
  "    $id = $null",
  "    try {",
  "        $reqBytes = [Convert]::FromBase64String($line)",
  "        $reqJson = [System.Text.Encoding]::UTF8.GetString($reqBytes)",
  "        $req = $reqJson | ConvertFrom-Json",
  "        $id = [string]$req.id",
  "        $scriptText = [string]$req.script",
  "",
  "        $stdout = ''",
  "        $stderr = ''",
  "        $exitCode = 0",
  "        try {",
  "            $sb = [scriptblock]::Create($scriptText)",
  "            $outputItems = & $sb 2>&1 3>&1 4>&1 5>&1 6>&1",
  "            $normal = [System.Collections.Generic.List[object]]::new()",
  "            foreach ($item in $outputItems) {",
  "                if ($item -is [System.Management.Automation.ErrorRecord] -or",
  "                    $item -is [System.Management.Automation.WarningRecord] -or",
  "                    $item -is [System.Management.Automation.VerboseRecord] -or",
  "                    $item -is [System.Management.Automation.DebugRecord] -or",
  "                    $item -is [System.Management.Automation.InformationRecord]) {",
  "                    $stderr += ($item.ToString() + \"`n\")",
  "                } else {",
  "                    $normal.Add($item)",
  "                }",
  "            }",
  "            if ($normal.Count -gt 0) {",
  "                $stdout = ($normal | Out-String)",
  "            }",
  "        } catch {",
  "            $stderr = $_.Exception.Message",
  "            $exitCode = 1",
  "        }",
  "",
  "        $resp = @{ id = $id; stdout = $stdout; stderr = $stderr; exitCode = $exitCode } | ConvertTo-Json -Compress",
  "    } catch {",
  "        $fallbackId = if ($id) { $id } else { '__unknown__' }",
  "        $resp = @{ id = $fallbackId; stdout = ''; stderr = \"Protocol error: $($_.Exception.Message)\"; exitCode = 1 } | ConvertTo-Json -Compress",
  "    }",
  "",
  "    $respBytes = [System.Text.Encoding]::UTF8.GetBytes($resp)",
  "    [Console]::Out.WriteLine([Convert]::ToBase64String($respBytes))",
  "    [Console]::Out.Flush()",
  "}",
].join("\n");

/**
 * Manages one long-lived `pwsh` process with dbatools pre-imported, so that
 * invoke_dbatools_command calls skip the module-import cost on every call.
 *
 * On crash or per-call timeout the process is killed and discarded; the next
 * call transparently spawns (and re-imports dbatools into) a fresh process.
 * There is no automatic retry of the call that triggered the failure — the
 * error is surfaced to the caller for that one invocation.
 */
class PersistentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private starting: Promise<void> | null = null;

  /** True once a process has completed the startup handshake successfully. */
  isActive(): boolean {
    return this.child !== null;
  }

  private async ensureStarted(config: ServerConfig): Promise<void> {
    if (this.child) return;
    if (!this.starting) {
      this.starting = this.spawnProcess(config).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private spawnProcess(config: ServerConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const encodedCommand = Buffer.from(DRIVER_SCRIPT, "utf16le").toString("base64");
      const child = spawn(
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
      ) as ChildProcessWithoutNullStreams;

      let settled = false;
      const rl = createInterface({ input: child.stdout });

      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error("Timed out waiting for the persistent PowerShell session to start.");
        rl.close();
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        reject(err);
      }, STARTUP_TIMEOUT_MS);

      rl.on("line", (line) => this.handleLine(line, { child, rl, startupTimer, isSettled: () => settled, markSettled: () => (settled = true), resolveStart: resolve, rejectStart: reject }));

      child.stderr.on("data", () => {
        // Driver-level stderr (host warnings unrelated to any specific
        // in-flight request) is intentionally not attributed to a pending
        // call; per-call diagnostics are captured inside the envelope itself.
      });

      child.on("error", (err) => {
        clearTimeout(startupTimer);
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to launch '${config.powershellExe}': ${err.message}`));
          return;
        }
        this.teardown(new Error(`Persistent PowerShell session error: ${err.message}`));
      });

      child.on("close", () => {
        clearTimeout(startupTimer);
        if (!settled) {
          settled = true;
          reject(new Error("Persistent PowerShell session exited before becoming ready."));
          return;
        }
        this.teardown(new Error("Persistent PowerShell session exited unexpectedly."));
      });
    });
  }

  private handleLine(
    line: string,
    ctx: {
      child: ChildProcessWithoutNullStreams;
      rl: Interface;
      startupTimer: NodeJS.Timeout;
      isSettled: () => boolean;
      markSettled: () => void;
      resolveStart: () => void;
      rejectStart: (err: Error) => void;
    }
  ): void {
    if (!line.trim()) return;

    let decoded: Buffer;
    try {
      decoded = Buffer.from(line, "base64");
    } catch {
      return; // ignore malformed/stray output
    }

    if (decoded.length > MAX_RESPONSE_BYTES) {
      // Can't reliably recover the id from a truncated/oversized payload;
      // drop it. The corresponding request will eventually time out.
      return;
    }

    let envelope: ResponseEnvelope;
    try {
      envelope = JSON.parse(decoded.toString("utf8"));
    } catch {
      return;
    }

    if (envelope.id === READY_ID) {
      clearTimeout(ctx.startupTimer);
      if (ctx.isSettled()) return;
      ctx.markSettled();
      if (envelope.exitCode === 0) {
        this.child = ctx.child;
        this.rl = ctx.rl;
        ctx.resolveStart();
      } else {
        try {
          ctx.child.kill("SIGKILL");
        } catch {
          // already dead
        }
        ctx.rejectStart(
          new Error(`dbatools import failed in persistent session: ${envelope.stderr || "unknown error"}`)
        );
      }
      return;
    }

    const pending = this.pending.get(envelope.id);
    if (!pending) return; // stale response (e.g. after a timeout teardown)
    clearTimeout(pending.timer);
    this.pending.delete(envelope.id);
    pending.resolve({
      stdout: envelope.stdout ?? "",
      stderr: envelope.stderr ?? "",
      exitCode: envelope.exitCode ?? 0,
    });
  }

  private teardown(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        // ignore
      }
    }
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    this.child = null;
    this.rl = null;
  }

  async run(script: string, config: ServerConfig): Promise<PowerShellResult> {
    await this.ensureStarted(config);
    const child = this.child;
    if (!child) {
      throw new Error("Persistent PowerShell session failed to start.");
    }

    const id = randomUUID();
    const payload = JSON.stringify({ id, script });
    const encoded = Buffer.from(payload, "utf8").toString("base64");

    return new Promise<PowerShellResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.teardown(
          new Error(`PowerShell process timed out after ${config.commandTimeout}s`)
        );
      }, config.commandTimeout * 1000);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(encoded + "\n", (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to write to persistent PowerShell session: ${err.message}`));
        }
      });
    });
  }

  /** Kills the underlying process, if any. Safe to call multiple times. */
  shutdown(): void {
    if (!this.child) return;
    this.teardown(new Error("Persistent PowerShell session shut down."));
  }
}

export const persistentSession = new PersistentSession();

/**
 * Runs a script through the persistent session when enabled, falling back to
 * a one-shot spawned process otherwise (config.usePersistentSession === false).
 */
export async function runPowerShellPersistent(
  script: string,
  config: ServerConfig
): Promise<PowerShellResult> {
  if (!config.usePersistentSession) {
    return runPowerShell(script, config);
  }
  return persistentSession.run(script, config);
}
