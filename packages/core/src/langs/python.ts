import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { GraphEdge, SymbolInfo } from "../graph/types.ts";

const require = createRequire(import.meta.url);

export interface PythonExtractor {
  extract(
    fileId: string,
    content: string,
    pyIds: Set<string>,
  ): { symbols: SymbolInfo[]; edges: GraphEdge[] };
}

let cached: Promise<PythonExtractor> | null = null;

/**
 * Tree-sitter Python extractor. Parser/grammar init is async and memoised, so a
 * single parser is reused across the whole scan. Replaces the earlier regex
 * extractor with real AST traversal — robust against comments, strings, and
 * imports nested inside try/if/function blocks.
 */
export function createPythonExtractor(): Promise<PythonExtractor> {
  if (!cached) cached = init();
  return cached;
}

async function init(): Promise<PythonExtractor> {
  const coreWasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => coreWasm } as object);
  // Grammar wasm shipped by tree-sitter-python itself — ABI-matched to a current
  // web-tree-sitter runtime (unlike the older prebuilt grammar packs).
  const grammar = require.resolve("tree-sitter-python/tree-sitter-python.wasm");
  const python = await Language.load(grammar);
  const parser = new Parser();
  parser.setLanguage(python);

  return {
    extract(fileId, content, pyIds) {
      const symbols: SymbolInfo[] = [];
      const edges: GraphEdge[] = [];
      const seen = new Set<string>();
      const tree = parser.parse(content);
      if (tree) walk(tree.rootNode, fileId, pyIds, symbols, edges, seen);
      return { symbols, edges };
    },
  };
}

function walk(
  node: Node,
  fileId: string,
  pyIds: Set<string>,
  symbols: SymbolInfo[],
  edges: GraphEdge[],
  seen: Set<string>,
): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case "import_statement":
        for (const mod of importedModules(child)) {
          const target = resolvePy(fileId, "", mod, pyIds);
          if (target) addEdge(edges, seen, fileId, target);
        }
        break;
      case "import_from_statement": {
        const { dots, mod } = fromModule(child);
        const target = resolvePy(fileId, dots, mod, pyIds);
        if (target) addEdge(edges, seen, fileId, target);
        break;
      }
      case "function_definition":
      case "class_definition":
        if (node.type === "module") {
          const name = child.childForFieldName("name");
          if (name) {
            symbols.push({
              name: name.text,
              kind: child.type === "class_definition" ? "class" : "def",
            });
          }
        }
        break;
    }
    // Recurse to catch imports nested inside try/if/function bodies.
    walk(child, fileId, pyIds, symbols, edges, seen);
  }
}

/** Module names from `import a.b`, `import a.b as c` (one statement may list several). */
function importedModules(node: Node): string[] {
  const mods: string[] = [];
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "dotted_name") mods.push(c.text);
    else if (c.type === "aliased_import") {
      const dn = c.namedChildren.find((x) => x?.type === "dotted_name");
      if (dn) mods.push(dn.text);
    }
  }
  return mods;
}

/** The module portion of a `from ... import ...`, with any leading relative dots. */
function fromModule(node: Node): { dots: string; mod: string } {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "dotted_name") return { dots: "", mod: c.text };
    if (c.type === "relative_import") {
      const m = /^(\.+)(.*)$/.exec(c.text);
      return { dots: m?.[1] ?? "", mod: m?.[2] ?? "" };
    }
    // Stop at the `import` keyword region; anything after is the imported names.
    if (c.type === "import_list" || c.type === "wildcard_import") break;
  }
  return { dots: "", mod: "" };
}

function addEdge(edges: GraphEdge[], seen: Set<string>, from: string, to: string): void {
  if (to === from || seen.has(to)) return;
  seen.add(to);
  edges.push({ from, to, kind: "import" });
}

/**
 * Resolve a (possibly relative) dotted module to a file id within the scanned set.
 * `dots` = leading dots of a relative import ("." current package, ".." parent, …).
 */
function resolvePy(
  fromId: string,
  dots: string,
  mod: string,
  pyIds: Set<string>,
): string | null {
  let baseDir: string[];
  if (dots.length > 0) {
    const parts = fromId.split("/");
    parts.pop(); // drop the filename
    for (let i = 1; i < dots.length; i++) parts.pop();
    baseDir = parts;
  } else {
    baseDir = [];
  }

  const modParts = mod ? mod.split(".") : [];
  const full = [...baseDir, ...modParts].filter(Boolean);
  if (full.length === 0) return null;

  const stem = full.join("/");
  for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
    if (pyIds.has(candidate)) return candidate;
  }
  return null;
}
