import fs from "node:fs";
import path from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { toId } from "../util/paths.ts";
import type { CallEdge, GraphEdge, GraphNode, Language, SymbolInfo } from "../graph/types.ts";

function langOf(file: string): Language {
  const ext = path.extname(file);
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
}

export interface TsJsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  calls: CallEdge[];
}

/**
 * Project-level extraction so cross-file module resolution is accurate
 * (path aliases, barrel files, index resolution) via the TypeScript Compiler API.
 * Emits file-level import edges and function-level call edges. Only edges whose
 * endpoints are in `files` are kept; resolution may pull in node_modules sources,
 * which we filter out.
 */
export function extractTsJs(root: string, files: string[]): TsJsResult {
  const tsconfig = path.join(root, "tsconfig.json");
  const project = fs.existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { allowJs: true } });

  for (const f of files) project.addSourceFileAtPathIfExists(f);

  const known = new Set(files.map((f) => path.resolve(f)));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const calls: CallEdge[] = [];

  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (!known.has(path.resolve(fp))) continue; // skip resolved node_modules sources

    const id = toId(root, fp);
    const symbols: SymbolInfo[] = [];
    try {
      for (const [name, decls] of sf.getExportedDeclarations()) {
        symbols.push({ name, kind: decls[0]?.getKindName() ?? "unknown" });
      }
    } catch {
      // getExportedDeclarations can throw on pathological files; symbols are best-effort.
    }
    nodes.push({ id, path: id, language: langOf(fp), symbols });

    // --- import edges (file-level) ---
    const importDecls = [...sf.getImportDeclarations(), ...sf.getExportDeclarations()];
    const seenImports = new Set<string>();
    for (const d of importDecls) {
      // ts-morph's module/symbol resolution can throw on pathological inputs;
      // skip the offending edge rather than aborting the whole scan.
      let target: ReturnType<typeof d.getModuleSpecifierSourceFile>;
      try {
        target = d.getModuleSpecifierSourceFile();
      } catch {
        continue;
      }
      if (!target) continue;
      const tp = path.resolve(target.getFilePath());
      if (!known.has(tp)) continue;
      const to = toId(root, target.getFilePath());
      if (to === id || seenImports.has(to)) continue;
      seenImports.add(to);
      edges.push({ from: id, to, kind: "import" });
    }

    // --- call edges (function-level) ---
    const seenCalls = new Set<string>();
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const target = resolveCallTarget(call, root, known);
      if (!target) continue;
      const fromSymbol = enclosingName(call);
      const key = `${fromSymbol}\0${target.to}\0${target.toSymbol}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      calls.push({ from: id, fromSymbol, to: target.to, toSymbol: target.toSymbol });
    }
  }

  return { nodes, edges, calls };
}

/** Resolve a call's callee to a { file, symbol } inside the scan set, or null. */
function resolveCallTarget(
  call: import("ts-morph").CallExpression,
  root: string,
  known: Set<string>,
): { to: string; toSymbol: string } | null {
  const expr = call.getExpression();
  // getSymbol/getAliasedSymbol (and the checker-backed calls below) can throw on
  // malformed or untyped calls under full-type resolution; treat any failure as
  // "unresolvable" and skip this call edge rather than aborting the whole scan.
  try {
    let sym = expr.getSymbol();
    if (!sym) return null;
    const aliased = sym.getAliasedSymbol();
    if (aliased) sym = aliased;

    const decl = sym.getDeclarations()[0];
    if (!decl) return null;

    // Skip invocations of callback parameters / destructured bindings — these are
    // real calls but add noise to a function-level map; keep named fns/methods.
    if (Node.isParameterDeclaration(decl) || Node.isBindingElement(decl)) return null;

    const declFile = path.resolve(decl.getSourceFile().getFilePath());
    if (!known.has(declFile)) return null; // external / built-in

    const name = sym.getName();
    if (!name || name === "default") return null;
    return { to: toId(root, decl.getSourceFile().getFilePath()), toSymbol: name };
  } catch {
    return null;
  }
}

/** Nearest named function/method/variable enclosing `node` ("<module>" if none). */
function enclosingName(node: Node): string {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isFunctionDeclaration(cur) || Node.isMethodDeclaration(cur)) {
      const n = cur.getName();
      if (n) return n;
    }
    if (Node.isVariableDeclaration(cur)) {
      const init = cur.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return cur.getName();
      }
    }
    cur = cur.getParent();
  }
  return "<module>";
}
