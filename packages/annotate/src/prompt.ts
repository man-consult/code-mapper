import type { AnnotateInput } from "./types.ts";

const MAX_SOURCE_CHARS = 12_000;

export const SYSTEM_PROMPT =
  "Given one source file, describe its role and the data flows it participates in. Be concrete and terse. " +
  "Never invent dependencies. Respond ONLY with a single JSON object. No prose, no code fences.";

export function buildUserPrompt(input: AnnotateInput): string {
  const source =
    input.source.length > MAX_SOURCE_CHARS
      ? `${input.source.slice(0, MAX_SOURCE_CHARS)}\n…(truncated)`
      : input.source;

  return [
    `File: ${input.id} (${input.language})`,
    input.dependencies.length ? `Imports: ${input.dependencies.join(", ")}` : "",
    "",
    "Source:",
    "```",
    source,
    "```",
    "",
    "Return JSON with exactly these keys:",
    '{"summary": string, "writes": string[], "reads": string[], "config": string[], "auth": string[], "flows": string[]}',
    "- summary: 1-2 sentences on what this file does.",
    "- writes: data stores this code WRITES to — DB tables/collections, caches, queues, topics.",
    "  Bare names only (e.g. users, sessions). EXCLUDE env vars, file/module paths, and connection handles.",
    "- reads: data stores this code READS from — same rules as writes.",
    "- config: environment variables / config / secrets this code reads (e.g. DATABASE_URL, PORT).",
    "- auth: authentication/authorization gates enforced or required here.",
    "- flows: short phrases describing how data moves through this file.",
    "Use [] for any category that does not apply.",
  ]
    .filter(Boolean)
    .join("\n");
}
