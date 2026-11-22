import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { CallEdge, GraphEdge, SymbolInfo } from "../graph/types.ts";

const require = createRequire(import.meta.url);

/** A call site resolved to a target file + symbol, pre symbol-existence check. */
export interface PendingCall {
  /** Enclosing function name at the call site, or "<module>". */
  fromSymbol: string;
  /** Target file id the callee resolves to. */
  to: string;
  /** Callee symbol name. */
  toSymbol: string;
}

export interface PythonExtractor {
  extract(
    fileId: string,
    content: string,
    pyIds: Set<string>,
  ): { symbols: SymbolInfo[]; edges: GraphEdge[]; calls: PendingCall[] };
}

let cached: Promise<PythonExtractor> | null = null;

/**
 * Tree-sitter Python extractor. Parser/grammar init is async and memoised, so a
 * single parser is reused across the whole scan. Produces import edges, module
 * symbols, and cross-file call sites resolved through imports (the only thing
 * statically knowable in Python). Calls are returned "pending" — the scanner
 * keeps only those whose target symbol is actually declared in the target file.
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
      const calls: PendingCall[] = [];
      const tree = parser.parse(content);
      if (!tree) return { symbols, edges, calls };

      const resolve = getResolver(pyIds);

      // Pass 1: imports (edges) + module symbols + name-resolution maps.
      // symbolMap: local name → (file, symbol) for `from mod import name`.
      // moduleMap: access path (e.g. "utils", "a.b") → file, for module-qualified calls.
      const symbolMap = new Map<string, { file: string; symbol: string }>();
      const moduleMap = new Map<string, string>();
      const seenEdge = new Set<string>();
      collectImports(tree.rootNode, fileId, resolve, symbols, edges, seenEdge, symbolMap, moduleMap);

      // Pass 2: call sites, resolved through the maps, tracking enclosing function.
      const seenCall = new Set<string>();
      collectCalls(tree.rootNode, "<module>", symbolMap, moduleMap, calls, seenCall);

      return { symbols, edges, calls };
    },
  };
}

type Resolve = (fromId: string, dots: string, mod: string) => string | null;

function collectImports(
  node: Node,
  fileId: string,
  resolve: Resolve,
  symbols: SymbolInfo[],
  edges: GraphEdge[],
  seen: Set<string>,
  symbolMap: Map<string, { file: string; symbol: string }>,
  moduleMap: Map<string, string>,
): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case "import_statement":
        // `import a.b`, `import a.b as c` — bind a module object.
        for (const { mod, alias } of importedModules(child)) {
          const target = resolve(fileId, "", mod);
          if (target) {
            addEdge(edges, seen, fileId, target);
            // Access path: the alias if any, else the full dotted path you'd type.
            moduleMap.set(alias ?? mod, target);
          }
        }
        break;
      case "import_from_statement": {
        const { dots, mod, names, wildcard } = fromImports(child);
        const modTarget = resolve(fileId, dots, mod);
        if (modTarget) addEdge(edges, seen, fileId, modTarget);
        if (wildcard) break;
        for (const { local, orig } of names) {
          // Is the imported name itself a submodule (`from pkg import submod`)?
          const sub = resolve(fileId, dots, mod ? `${mod}.${orig}` : orig);
          if (sub) {
            addEdge(edges, seen, fileId, sub);
            moduleMap.set(local, sub); // a module → calls look like `local.fn()`
          } else if (modTarget) {
            symbolMap.set(local, { file: modTarget, symbol: orig }); // a symbol → `local()`
          }
        }
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
    collectImports(child, fileId, resolve, symbols, edges, seen, symbolMap, moduleMap);
  }
}

/**
 * Walk for call sites, carrying the nearest enclosing function name. A call to
 * an imported name (`compute()`) or a module-qualified name (`utils.compute()`)
 * resolves to a target file + symbol via the import maps.
 */
function collectCalls(
  node: Node,
  fn: string,
  symbolMap: Map<string, { file: string; symbol: string }>,
  moduleMap: Map<string, string>,
  calls: PendingCall[],
  seen: Set<string>,
): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "function_definition") {
      const name = child.childForFieldName("name")?.text ?? fn;
      collectCalls(child, name, symbolMap, moduleMap, calls, seen);
      continue;
    }
    if (child.type === "call") resolveCall(child, fn, symbolMap, moduleMap, calls, seen);
    collectCalls(child, fn, symbolMap, moduleMap, calls, seen);
  }
}

function resolveCall(
  call: Node,
  fn: string,
  symbolMap: Map<string, { file: string; symbol: string }>,
  moduleMap: Map<string, string>,
  calls: PendingCall[],
  seen: Set<string>,
): void {
  const callee = call.childForFieldName("function");
  if (!callee) return;
  if (callee.type === "identifier") {
    const t = symbolMap.get(callee.text);
    if (t) addCall(calls, seen, fn, t.file, t.symbol);
  } else if (callee.type === "attribute") {
    const obj = callee.childForFieldName("object");
    const attr = callee.childForFieldName("attribute");
    if (obj && attr) {
      const file = moduleMap.get(obj.text);
      if (file) addCall(calls, seen, fn, file, attr.text);
    }
  }
}

/** Modules from `import a.b`, `import a.b as c` (one statement may list several). */
function importedModules(node: Node): { mod: string; alias?: string }[] {
  const mods: { mod: string; alias?: string }[] = [];
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "dotted_name") {
      mods.push({ mod: c.text });
    } else if (c.type === "aliased_import") {
      const dn = c.childForFieldName("name");
      const alias = c.childForFieldName("alias");
      if (dn) mods.push({ mod: dn.text, alias: alias?.text });
    }
  }
  return mods;
}

/** Parse `from <mod> import a, b as c` (or `*`) into module + imported names. */
function fromImports(node: Node): {
  dots: string;
  mod: string;
  names: { local: string; orig: string }[];
  wildcard: boolean;
} {
  const named = node.namedChildren.filter((c): c is Node => Boolean(c));
  const first = named[0];
  let dots = "";
  let mod = "";
  if (first?.type === "dotted_name") {
    mod = first.text;
  } else if (first?.type === "relative_import") {
    const m = /^(\.+)(.*)$/.exec(first.text);
    dots = m?.[1] ?? "";
    mod = m?.[2] ?? "";
  }

  const names: { local: string; orig: string }[] = [];
  let wildcard = false;
  for (const c of named.slice(1)) {
    if (c.type === "wildcard_import") wildcard = true;
    else if (c.type === "dotted_name") names.push({ local: c.text, orig: c.text });
    else if (c.type === "aliased_import") {
      const orig = c.childForFieldName("name")?.text;
      const alias = c.childForFieldName("alias")?.text;
      if (orig) names.push({ local: alias ?? orig, orig });
    }
  }
  return { dots, mod, names, wildcard };
}

function addEdge(edges: GraphEdge[], seen: Set<string>, from: string, to: string): void {
  if (to === from || seen.has(to)) return;
  seen.add(to);
  edges.push({ from, to, kind: "import" });
}

function addCall(
  calls: PendingCall[],
  seen: Set<string>,
  fromSymbol: string,
  to: string,
  toSymbol: string,
): void {
  const key = `${fromSymbol} ${to} ${toSymbol}`;
  if (seen.has(key)) return;
  seen.add(key);
  calls.push({ fromSymbol, to, toSymbol });
}

/**
 * A module resolver bound to one scanned file set. Cached per set so the suffix
 * index is built once per scan, not once per file.
 *
 * Relative imports (`from .x import y`) resolve against the importing file's
 * package. Absolute imports (`from hipper.db import x`) resolve root-relative
 * first, then fall back to suffix-matching the file set — so a package living
 * under a source root (e.g. `backend/src/hipper/…`) still resolves, which is the
 * common Python "src layout". Suffix matches are made deterministic and are
 * restricted to qualified (≥2-segment) imports to avoid bare-name collisions.
 */
const resolverCache = new WeakMap<Set<string>, Resolve>();

function getResolver(pyIds: Set<string>): Resolve {
  const cached = resolverCache.get(pyIds);
  if (cached) return cached;

  // last module segment → file ids that could match it.
  const byLastSegment = new Map<string, string[]>();
  for (const id of pyIds) {
    const seg = id.endsWith("/__init__.py")
      ? id.slice(0, -"/__init__.py".length).split("/").pop()
      : id.endsWith(".py")
        ? id.slice(0, -3).split("/").pop()
        : undefined;
    if (!seg) continue;
    (byLastSegment.get(seg) ?? byLastSegment.set(seg, []).get(seg)!).push(id);
  }

  /** The dotted module path a file id represents (drop .py / /__init__.py). */
  const moduleStem = (id: string): string =>
    id.endsWith("/__init__.py") ? id.slice(0, -"/__init__.py".length) : id.slice(0, -3);

  const resolve: Resolve = (fromId, dots, mod) => {
    if (dots.length > 0) {
      // Relative: resolve against the importing file's package directory.
      const parts = fromId.split("/");
      parts.pop();
      for (let i = 1; i < dots.length; i++) parts.pop();
      const full = [...parts, ...(mod ? mod.split(".") : [])].filter(Boolean);
      if (full.length === 0) return null;
      const stem = full.join("/");
      for (const c of [`${stem}.py`, `${stem}/__init__.py`]) if (pyIds.has(c)) return c;
      return null;
    }

    const modParts = mod ? mod.split(".") : [];
    if (modParts.length === 0) return null;
    const stem = modParts.join("/");
    // Absolute, root-relative first.
    for (const c of [`${stem}.py`, `${stem}/__init__.py`]) if (pyIds.has(c)) return c;

    // Source-root fallback: a file whose module path ends with `stem`. Only for
    // qualified imports — bare `import config` stays root-relative to avoid noise.
    if (modParts.length < 2) return null;
    const last = modParts[modParts.length - 1]!;
    const matches = (byLastSegment.get(last) ?? []).filter((id) => {
      const s = moduleStem(id);
      return s === stem || s.endsWith(`/${stem}`);
    });
    if (matches.length === 0) return null;
    // Deterministic: shallowest path wins, then lexicographic.
    matches.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return matches[0]!;
  };

  resolverCache.set(pyIds, resolve);
  return resolve;
}
