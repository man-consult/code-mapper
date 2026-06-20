import fs from "node:fs";
import path from "node:path";
import { assertInside, assertSafeOutputDir } from "../util/paths.ts";
import type { CallEdge, CodeGraph, GraphNode } from "../graph/types.ts";

export interface VaultResult {
  files: number;
  outDir: string;
}

/**
 * Render the graph into an Obsidian-linkable Markdown vault.
 * One note per node, mirroring the source tree; `[[wikilinks]]` are real
 * dependency edges. Also writes `graph.json` for the web UI.
 */
export function writeVault(graph: CodeGraph, outDirInput: string): VaultResult {
  const outDir = assertSafeOutputDir(outDirInput);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graph, null, 2));

  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    (deps.get(e.from) ?? deps.set(e.from, new Set()).get(e.from)!).add(e.to);
    (dependents.get(e.to) ?? dependents.set(e.to, new Set()).get(e.to)!).add(e.from);
  }

  const callsOut = new Map<string, CallEdge[]>();
  const callsIn = new Map<string, CallEdge[]>();
  for (const c of graph.calls) {
    (callsOut.get(c.from) ?? callsOut.set(c.from, []).get(c.from)!).push(c);
    (callsIn.get(c.to) ?? callsIn.set(c.to, []).get(c.to)!).push(c);
  }

  let files = 0;
  for (const node of graph.nodes) {
    // Containment: a crafted graph.json with node.id="../../etc" must not write
    // outside the vault. Skip any node whose note path escapes outDir.
    let notePath: string;
    try {
      notePath = assertInside(outDir, path.join(outDir, `${node.id}.md`));
    } catch {
      continue;
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(
      notePath,
      renderNote(
        node,
        [...(deps.get(node.id) ?? [])].sort(),
        [...(dependents.get(node.id) ?? [])].sort(),
        callsOut.get(node.id) ?? [],
        callsIn.get(node.id) ?? [],
      ),
    );
    files++;
  }

  return { files, outDir };
}

function list(ids: string[]): string {
  return ids.length ? ids.map((id) => `- [[${id}]]`).join("\n") : "_none_";
}

/** YAML-safe inline list, e.g. [a, "b: c"]. */
function yamlList(items: string[]): string {
  return `[${items.map((s) => (/[:#\[\]]/.test(s) ? JSON.stringify(s) : s)).join(", ")}]`;
}

function callsOutList(calls: CallEdge[]): string {
  if (!calls.length) return "_none_";
  return calls
    .map((c) => `- \`${c.fromSymbol}\` → [[${c.to}]] \`${c.toSymbol}\``)
    .join("\n");
}

function callsInList(calls: CallEdge[]): string {
  if (!calls.length) return "_none_";
  return calls
    .map((c) => `- [[${c.from}]] \`${c.fromSymbol}\` → \`${c.toSymbol}\``)
    .join("\n");
}

function renderNote(
  node: GraphNode,
  deps: string[],
  dependents: string[],
  callsOut: CallEdge[],
  callsIn: CallEdge[],
): string {
  const symbols = node.symbols.map((s) => s.name);
  const a = node.annotation;

  const frontmatter = [
    "---",
    `path: ${node.path}`,
    `language: ${node.language}`,
    `symbols: ${yamlList(symbols)}`,
  ];
  if (a) {
    frontmatter.push(
      `summary: ${JSON.stringify(a.summary)}`,
      `writes: ${yamlList(a.writes)}`,
      `reads: ${yamlList(a.reads)}`,
      `config: ${yamlList(a.config ?? [])}`,
      `auth: ${yamlList(a.auth)}`,
    );
  }
  frontmatter.push("---", "");

  const body = [`# ${node.path}`, ""];
  if (a) {
    body.push(a.summary, "");
    if (a.flows.length) {
      body.push("## Data flow", a.flows.map((f) => `- ${f}`).join("\n"), "");
    }
  }
  body.push("## Dependencies", list(deps), "", "## Dependents", list(dependents), "");
  if (callsOut.length || callsIn.length) {
    body.push(
      "",
      "## Calls",
      callsOutList(callsOut),
      "",
      "## Called by",
      callsInList(callsIn),
      "",
    );
  }

  return [...frontmatter, ...body].join("\n");
}
