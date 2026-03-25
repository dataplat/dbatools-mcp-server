/** Represents one parameter from Get-Help -Full output */
export interface DbatoolsParameter {
  name: string;
  type: string;
  required: boolean;
  aliases: string[];
  pipelineInput: boolean;
  description: string;
  defaultValue?: string;
}

/** One example block from Get-Help -Full output */
export interface DbatoolsExample {
  title: string;
  code: string;
  remarks: string;
}

/** Full normalized help payload for one dbatools command */
export interface DbatoolsCommandHelp {
  name: string;
  verb: string;
  noun: string;
  synopsis: string;
  description: string;
  parameters: DbatoolsParameter[];
  examples: DbatoolsExample[];
  relatedLinks: string[];
  tags: string[];
  riskLevel: "readonly" | "change" | "destructive";
}

/** The full dbatools-help.json manifest written by refresh-help.ps1 */
export interface HelpManifest {
  generatedAt: string;
  dbatoolsVersion: string;
  commandCount: number;
  commands: HelpIndex;
}

/** Keyed by command name, e.g. "Get-DbaDatabase" */
export type HelpIndex = Record<string, DbatoolsCommandHelp>;

/** Result returned from running a PowerShell script */
export interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runtime configuration resolved from environment variables */
export interface ServerConfig {
  powershellExe: string;
  /** When true, non-readonly commands require confirm:true */
  safeMode: boolean;
  /** Maximum rows piped through Select-Object before ConvertTo-Json */
  maxOutputRows: number;
  /** Seconds before the PowerShell child process is killed */
  commandTimeout: number;
}
