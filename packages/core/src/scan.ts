import fs from "node:fs";
import path from "node:path";
import { assertInside, toId } from "./util/paths.ts";
import { extractTsJs } from "./langs/ts-js.ts";
import { createPythonExtractor } from "./langs/python.ts";
import type { CallEdge, CodeGraph, GraphEdge, GraphNode } from "./graph/types.ts";

const TS_JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".codemap", "__pycache__", "venv", ".venv",
]);

export interface ScanOptions {
  /** Directory name to skip during the walk (e.g. the vault output folder). */
  outDirName?: string;
}

export async function scanRepo(rootInput: string, opts: ScanOptions = {}): Promise<CodeGraph> {
  const root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${rootInput}`);
  }

  const tsFiles: string[] = [];
  const pyFiles: string[] = [];
  walk(root, opts.outDirName, tsFiles, pyFiles);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const calls: CallEdge[] = [];

  if (tsFiles.length) {
    const res = extractTsJs(root, tsFiles);
    nodes.push(...res.nodes);
    edges.push(...res.edges);
    calls.push(...res.calls);
  }

  if (pyFiles.length) {
    const pyIds = new Set(pyFiles.map((f) => toId(root, f)));
    const python = await createPythonExtractor();
    for (const f of pyFiles) {
      const id = toId(root, f);
      const content = fs.readFileSync(assertInside(root, f), "utf8");
      const { symbols, edges: e } = python.extract(id, content, pyIds);
      nodes.push({ id, path: id, language: "python", symbols });
      edges.push(...e);
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  calls.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.fromSymbol.localeCompare(b.fromSymbol) ||
      a.to.localeCompare(b.to) ||
      a.toSymbol.localeCompare(b.toSymbol),
  );
  return { root, nodes, edges, calls };
}

function walk(dir: string, outDirName: string | undefined, tsFiles: string[], pyFiles: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs (.git, .claude, .venv, .next, …), the explicit skip-list
      // (node_modules, dist, build, …), and the output vault. Hidden dirs in
      // particular hide things like .claude/worktrees — full duplicate checkouts
      // that would double-count the whole repo.
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) || entry.name === outDirName) {
        continue;
      }
      walk(full, outDirName, tsFiles, pyFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (TS_JS_EXT.has(ext)) tsFiles.push(full);
      else if (ext === ".py") pyFiles.push(full);
    }
  }
}
