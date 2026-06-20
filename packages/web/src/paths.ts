import type { CodeGraph } from "./types.ts";

export interface Adjacency {
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
}

export function buildAdjacency(graph: CodeGraph): Adjacency {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const e of graph.edges) {
    (forward.get(e.from) ?? forward.set(e.from, []).get(e.from)!).push(e.to);
    (reverse.get(e.to) ?? reverse.set(e.to, []).get(e.to)!).push(e.from);
  }
  return { forward, reverse };
}

/** All nodes reachable from `start` along the given adjacency (excludes start). */
export function reachable(adj: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of adj.get(n) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        stack.push(m);
      }
    }
  }
  return seen;
}
