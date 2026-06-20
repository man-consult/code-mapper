import type { CodeGraph, GraphEdge, GraphNode } from "./types.ts";

/**
 * Derive a function-level graph from the file graph's `calls`.
 * Nodes are `file#symbol`; edges are calls. Each symbol node inherits its
 * parent file's annotation so the details panel still has context.
 */
export function buildCallGraph(graph: CodeGraph): CodeGraph {
  const calls = graph.calls ?? [];
  const fileNode = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = new Map<string, GraphNode>();

  const symId = (file: string, sym: string) => `${file}#${sym}`;
  function ensure(file: string, sym: string): string {
    const id = symId(file, sym);
    if (!nodes.has(id)) {
      const parent = fileNode.get(file);
      nodes.set(id, {
        id,
        path: id,
        language: parent?.language ?? "typescript",
        symbols: [],
        annotation: parent?.annotation,
      });
    }
    return id;
  }

  const edges: GraphEdge[] = calls.map((c) => ({
    from: ensure(c.from, c.fromSymbol),
    to: ensure(c.to, c.toSymbol),
    kind: "call",
  }));

  return { root: graph.root, nodes: [...nodes.values()], edges, calls: [] };
}
