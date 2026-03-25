import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { HelpIndex, HelpManifest, DbatoolsCommandHelp } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELP_INDEX_PATH = join(__dirname, "../generated/dbatools-help.json");

let cachedManifest: HelpManifest | null = null;

/**
 * Load and cache the help manifest from generated/dbatools-help.json.
 * Throws an actionable error if the file has not been generated yet.
 */
export function loadHelpManifest(): HelpManifest {
  if (cachedManifest) return cachedManifest;

  if (!existsSync(HELP_INDEX_PATH)) {
    throw new Error(
      `Help index not found at: ${HELP_INDEX_PATH}\n` +
        `Run 'npm run refresh-help' to generate it from your local dbatools installation.`
    );
  }

  const raw = readFileSync(HELP_INDEX_PATH, "utf-8");
  cachedManifest = JSON.parse(raw) as HelpManifest;
  return cachedManifest;
}

/** Shorthand to get just the commands map from the manifest. */
export function loadHelpIndex(): HelpIndex {
  return loadHelpManifest().commands;
}

export interface SearchOptions {
  verb?: string;
  noun?: string;
  keyword?: string;
  riskLevel?: string;
  limit?: number;
}

/**
 * Filter the help index with optional verb / noun / keyword / riskLevel filters.
 * Keyword matches against name, synopsis, and description (case-insensitive).
 */
export function searchCommands(
  index: HelpIndex,
  opts: SearchOptions
): DbatoolsCommandHelp[] {
  let commands = Object.values(index);

  if (opts.verb) {
    const v = opts.verb.toLowerCase();
    commands = commands.filter((c) => c.verb.toLowerCase() === v);
  }

  if (opts.noun) {
    const n = opts.noun.toLowerCase();
    commands = commands.filter((c) => c.noun.toLowerCase().includes(n));
  }

  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase();
    commands = commands.filter(
      (c) =>
        c.name.toLowerCase().includes(kw) ||
        c.synopsis.toLowerCase().includes(kw) ||
        c.description.toLowerCase().includes(kw) ||
        c.tags.some((t) => t.toLowerCase().includes(kw))
    );
  }

  if (opts.riskLevel) {
    commands = commands.filter((c) => c.riskLevel === opts.riskLevel);
  }

  return commands.slice(0, opts.limit ?? 50);
}
