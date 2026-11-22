import type { CodeGraph } from "../graph/types.ts";

/**
 * Repo-onboarding curriculum: a deterministic, explainable reading order over
 * the import graph. This is the *symbolic* half of the NeSy split — topology
 * decides WHAT to read and in WHAT ORDER; the LLM (elsewhere) only narrates.
 *
 * Nothing here is inferred by a model. Order falls out of graph structure:
 * import cycles are folded (Tarjan SCC), the condensed DAG is laid out
 * foundations-first (a file's dependencies precede it), and importance is
 * in-degree centrality (how many files import you). Every sort has an explicit
 * id tie-break, so the output is fully reproducible.
 */

export type StopRole = "entrypoint" | "hub" | "foundation" | "leaf" | "core";

/**
 * Reading direction — two valid stories over the same graph:
 *  - "foundations": building blocks first; a file is introduced after the files
 *    it depends on (you never read a file before its dependencies).
 *  - "entrypoints": entry points first; descend through imports into detail
 *    (you read a file before the things it pulls in).
 */
export type ReadingOrder = "foundations" | "entrypoints";

export interface CurriculumStop {
  /** Node id (file path relative to scan root). */
  id: string;
  /** 1-based position in the whole tour. */
  order: number;
  role: StopRole;
  /** In-degree: how many in-scope files import this one. */
  dependedOnBy: number;
  /** Out-degree: how many in-scope files this one imports. */
  dependsOn: number;
  /** Deps already introduced earlier in the tour ("you've read these"). */
  seenDeps: string[];
  /** Deps not yet introduced ("you'll meet these later"). */
  newDeps: string[];
  /** Sibling ids when this file sits in an import cycle (SCC size > 1). */
  cluster: string[];
  /** Symbol names declared here (truncated). */
  symbols: string[];
  /** Reused from the annotation pass when present — the only "neural" input. */
  summary?: string;
  /** Deterministic one-line rationale, composed from the topology. */
  why: string;
}

export interface CurriculumChapter {
  title: string;
  kind: "spine" | "module";
  blurb: string;
  stops: CurriculumStop[];
}

export interface CurriculumExcluded {
  tests: number;
  generated: number;
  trivial: number;
  total: number;
}

export interface Curriculum {
  root: string;
  /** Which reading story this curriculum tells. */
  order: ReadingOrder;
  chapters: CurriculumChapter[];
  totalStops: number;
  /** In-scope files (excludes filtered noise). */
  totalFiles: number;
  excluded: CurriculumExcluded;
  /** Number of multi-file import cycles folded into clusters. */
  cycles: number;
}

export interface CurriculumOptions {
  /** Reading direction. Default "foundations". */
  order?: ReadingOrder;
  /** Max files in the orientation ("spine") chapter. Default 7. */
  spineSize?: number;
  /** Max symbols recorded per stop. Default 8. */
  maxSymbols?: number;
}

const ENTRYPOINT_RE =
  /(^|\/)(index|main|server|app|cli|routes?|mod|__main__)\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const TEST_RE = /(^|\/)(__tests__|tests?|__mocks__)\/|\.(test|spec|stories)\.|_test\.py$/;
const GENERATED_RE = /\.d\.ts$|\.(gen|generated|min)\.|(^|\/)migrations?\//;

/** Classify why a node was dropped, or null to keep it. */
function exclusionOf(id: string, hasSymbols: boolean, degree: number): keyof CurriculumExcluded | null {
  if (TEST_RE.test(id)) return "tests";
  if (GENERATED_RE.test(id)) return "generated";
  // Truly inert: nothing declared and nothing wired to it.
  if (!hasSymbols && degree === 0) return "trivial";
  return null;
}

/** First path segment, or "(root)" for top-level files. Used to group chapters. */
function moduleOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? "(root)" : id.slice(0, slash);
}

/**
 * Build the reading-order curriculum from a scanned graph. Pure and
 * deterministic — same graph in, same curriculum out.
 */
export function buildCurriculum(graph: CodeGraph, opts: CurriculumOptions = {}): Curriculum {
  const order: ReadingOrder = opts.order ?? "foundations";
  const spineSize = opts.spineSize ?? 7;
  const maxSymbols = opts.maxSymbols ?? 8;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Raw degree (both directions) over import edges, for the keep/drop decision.
  const rawDegree = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    rawDegree.set(e.from, (rawDegree.get(e.from) ?? 0) + 1);
    rawDegree.set(e.to, (rawDegree.get(e.to) ?? 0) + 1);
  }

  // 1. Partition nodes into in-scope vs excluded (with reasons, reported).
  const excluded: CurriculumExcluded = { tests: 0, generated: 0, trivial: 0, total: 0 };
  const inScope = new Set<string>();
  for (const n of graph.nodes) {
    const reason = exclusionOf(n.id, n.symbols.length > 0, rawDegree.get(n.id) ?? 0);
    if (reason) {
      excluded[reason]++;
      excluded.total++;
    } else {
      inScope.add(n.id);
    }
  }

  // 2. Import adjacency among in-scope nodes only. deps = "a imports b" (a→b);
  //    dependents = reverse. Self-edges and dupes dropped.
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const id of inScope) {
    deps.set(id, new Set());
    dependents.set(id, new Set());
  }
  for (const e of graph.edges) {
    if (e.from === e.to || !inScope.has(e.from) || !inScope.has(e.to)) continue;
    deps.get(e.from)!.add(e.to);
    dependents.get(e.to)!.add(e.from);
  }

  const centrality = (id: string) => dependents.get(id)?.size ?? 0;

  // 3. Tarjan SCC over the depends-on graph to fold import cycles into clusters.
  const { components, compOf } = tarjanScc(inScope, deps);
  const cycles = components.filter((c) => c.length > 1).length;

  // 4. Condensed DAG, both directions: compDeps[c] = comps c depends on;
  //    compDependents[c] = comps that depend on c. Topo-sort with ties broken by
  //    importance, so load-bearing modules surface earliest within each layer.
  //    - foundations: a component is emitted only after its dependencies → deps
  //      block it, and emitting it unblocks its dependents.
  //    - entrypoints: a component is emitted only after its dependents → the
  //      reverse, so entry points (depended on by nothing) come first.
  const compDeps = new Map<number, Set<number>>();
  const compDependents = new Map<number, Set<number>>();
  const compImportance = new Map<number, number>();
  components.forEach((_, ci) => {
    compDeps.set(ci, new Set());
    compDependents.set(ci, new Set());
    compImportance.set(ci, 0);
  });
  for (const id of inScope) {
    const ci = compOf.get(id)!;
    compImportance.set(ci, Math.max(compImportance.get(ci)!, centrality(id)));
    for (const d of deps.get(id)!) {
      const cj = compOf.get(d)!;
      if (cj !== ci) {
        compDeps.get(ci)!.add(cj);
        compDependents.get(cj)!.add(ci);
      }
    }
  }
  const blockedBy = order === "entrypoints" ? compDependents : compDeps;
  const unblocks = order === "entrypoints" ? compDeps : compDependents;
  const compOrder = topoSort(blockedBy, unblocks, compImportance);

  // 5. Flatten components into a global foundations-first node order. Within a
  //    component (a cycle, usually size 1) order by importance then id.
  const globalOrder: string[] = [];
  for (const ci of compOrder) {
    const members = [...components[ci]!].sort(
      (a, b) => centrality(b) - centrality(a) || a.localeCompare(b),
    );
    globalOrder.push(...members);
  }
  const rank = new Map(globalOrder.map((id, i) => [id, i]));

  // 6. Orientation chapter ("the spine"): the landmarks. Entry points (wire the
  //    app, imported by ~nobody) plus the highest-centrality hubs.
  const isEntrypoint = (id: string) => ENTRYPOINT_RE.test(id) && centrality(id) === 0;
  const spineIds = [...inScope]
    .sort((a, b) => {
      const ea = isEntrypoint(a) ? 1 : 0;
      const eb = isEntrypoint(b) ? 1 : 0;
      if (ea !== eb) return eb - ea; // entry points first
      return centrality(b) - centrality(a) || a.localeCompare(b);
    })
    .filter((id, i) => i < spineSize && (isEntrypoint(id) || centrality(id) > 1))
    .slice(0, spineSize);
  const spineSet = new Set(spineIds);

  // 7. Module chapters: the remaining files, grouped by top-level directory,
  //    each chapter laid out foundations-first (via the global rank).
  const byModule = new Map<string, string[]>();
  for (const id of globalOrder) {
    if (spineSet.has(id)) continue;
    const m = moduleOf(id);
    (byModule.get(m) ?? byModule.set(m, []).get(m)!).push(id);
  }
  const moduleImportance = (ids: string[]) => ids.reduce((mx, id) => Math.max(mx, centrality(id)), 0);
  const moduleChapters = [...byModule.entries()].sort(
    (a, b) => moduleImportance(b[1]) - moduleImportance(a[1]) || a[0].localeCompare(b[0]),
  );

  // 8. Assemble chapters, then number stops globally so seen/new deps are exact.
  const chapters: CurriculumChapter[] = [];
  if (spineIds.length) {
    // Foundations: lead with the most depended-on hubs. Entry points: lead with
    // the entry points themselves — that's where this story starts.
    const spineSorted = spineIds.slice().sort((a, b) => {
      if (order === "entrypoints") {
        const ea = isEntrypoint(a) ? 1 : 0;
        const eb = isEntrypoint(b) ? 1 : 0;
        if (ea !== eb) return eb - ea;
      }
      return centrality(b) - centrality(a) || a.localeCompare(b);
    });
    chapters.push({
      title: "The spine",
      kind: "spine",
      blurb:
        order === "entrypoints"
          ? "The landmarks, entry points first: where execution begins and the modules the most code leans on. Start here, then follow the imports down."
          : "The load-bearing files: entry points that wire things together and the modules the most code depends on. Skim these first to get the map; you'll revisit them in context.",
      stops: spineSorted.map((id) => makeStop(id)),
    });
  }
  const moduleTail =
    order === "entrypoints"
      ? "ordered top-down — each file before the things it pulls in."
      : "ordered so each file's dependencies come before it.";
  for (const [mod, ids] of moduleChapters) {
    ids.sort((a, b) => (rank.get(a)! - rank.get(b)!));
    chapters.push({
      title: mod,
      kind: "module",
      blurb: `${ids.length} file${ids.length === 1 ? "" : "s"} in ${mod}, ${moduleTail}`,
      stops: ids.map((id) => makeStop(id)),
    });
  }

  // Single pass to assign order + seen/new deps in tour sequence.
  const seen = new Set<string>();
  let stopNo = 0;
  for (const ch of chapters) {
    for (const stop of ch.stops) {
      stop.order = ++stopNo;
      const all = [...(deps.get(stop.id) ?? [])].sort();
      stop.seenDeps = all.filter((d) => seen.has(d));
      stop.newDeps = all.filter((d) => !seen.has(d));
      seen.add(stop.id);
    }
  }

  return {
    root: graph.root,
    order,
    chapters,
    totalStops: stopNo,
    totalFiles: inScope.size,
    excluded,
    cycles,
  };

  // --- helpers closing over the maps above ---

  function roleOf(id: string): StopRole {
    const inDeg = centrality(id);
    const outDeg = deps.get(id)?.size ?? 0;
    if (isEntrypoint(id)) return "entrypoint";
    if (inDeg >= 8) return "hub";
    if (inDeg > 0 && outDeg === 0) return "foundation";
    if (inDeg === 0) return "leaf";
    return "core";
  }

  function makeStop(id: string): CurriculumStop {
    const node = nodeById.get(id)!;
    const inDeg = centrality(id);
    const outDeg = deps.get(id)?.size ?? 0;
    const cluster = (components[compOf.get(id)!] ?? []).filter((m) => m !== id);
    const role = roleOf(id);
    return {
      id,
      order: 0, // assigned in the numbering pass
      role,
      dependedOnBy: inDeg,
      dependsOn: outDeg,
      seenDeps: [],
      newDeps: [],
      cluster: cluster.sort(),
      symbols: node.symbols.slice(0, maxSymbols).map((s) => s.name),
      summary: node.annotation?.summary,
      why: whyLine(role, inDeg, outDeg, cluster.length),
    };
  }
}

function whyLine(role: StopRole, inDeg: number, outDeg: number, clusterSiblings: number): string {
  if (clusterSiblings > 0) {
    return `In an import cycle with ${clusterSiblings} other file${clusterSiblings === 1 ? "" : "s"} — read them as one unit.`;
  }
  switch (role) {
    case "entrypoint":
      return `Entry point — wires the app together and pulls in ${outDeg} module${outDeg === 1 ? "" : "s"} you'll meet next.`;
    case "hub":
      return `Hub: imported by ${inDeg} files. Load-bearing — learn its shape and names.`;
    case "foundation":
      return `Foundation: depends on nothing internal, and ${inDeg} file${inDeg === 1 ? "" : "s"} build on it.`;
    case "leaf":
      return `Standalone — nothing imports it; depends on ${outDeg} module${outDeg === 1 ? "" : "s"}.`;
    default:
      return `${inDeg} importer${inDeg === 1 ? "" : "s"}, ${outDeg} dependenc${outDeg === 1 ? "y" : "ies"}.`;
  }
}

/**
 * Tarjan's strongly-connected-components over the depends-on graph. Iterative
 * (no recursion limit on huge repos). Returns components and a node→component
 * index. Components come out in reverse topological order, but we re-sort the
 * condensation explicitly, so that detail doesn't matter here.
 */
function tarjanScc(
  nodes: Set<string>,
  deps: Map<string, Set<string>>,
): { components: string[][]; compOf: Map<string, number> } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const compOf = new Map<string, number>();
  let counter = 0;

  // Deterministic node iteration order.
  const order = [...nodes].sort();

  for (const start of order) {
    if (index.has(start)) continue;
    // Explicit work stack of (node, iterator-position).
    const work: { node: string; nbrs: string[]; i: number }[] = [];
    const pushNode = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, nbrs: [...(deps.get(node) ?? [])].sort(), i: 0 });
    };
    pushNode(start);

    while (work.length) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.nbrs.length) {
        const w = frame.nbrs[frame.i++]!;
        if (!nodes.has(w)) continue;
        if (!index.has(w)) {
          pushNode(w);
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
      } else {
        // Done with this node: settle low-links and emit an SCC at a root.
        if (low.get(frame.node) === index.get(frame.node)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            compOf.set(w, components.length);
            if (w === frame.node) break;
          }
          components.push(comp);
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) {
          parent.node && low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
      }
    }
  }

  return { components, compOf };
}

/**
 * Kahn's algorithm over the condensation. A component is emitted only once every
 * component that "blocks" it has been emitted; emitting it then unblocks its
 * successors. Direction is chosen by the caller (blockedBy = dependencies for
 * foundations-first, or dependents for entry-point-first). Ties broken by
 * importance (desc) then index, for determinism.
 */
function topoSort(
  blockedBy: Map<number, Set<number>>,
  unblocks: Map<number, Set<number>>,
  importance: Map<number, number>,
): number[] {
  // remaining[c] = how many of c's blockers are not yet emitted.
  const remaining = new Map<number, number>();
  for (const [c, set] of blockedBy) remaining.set(c, set.size);

  const pick = (a: number, b: number) =>
    (importance.get(b) ?? 0) - (importance.get(a) ?? 0) || a - b;

  let ready = [...remaining.entries()].filter(([, n]) => n === 0).map(([c]) => c);
  const out: number[] = [];
  const emitted = new Set<number>();
  while (ready.length) {
    ready.sort(pick);
    const c = ready.shift()!;
    if (emitted.has(c)) continue;
    emitted.add(c);
    out.push(c);
    for (const succ of unblocks.get(c) ?? []) {
      remaining.set(succ, (remaining.get(succ) ?? 0) - 1);
      if (remaining.get(succ) === 0) ready.push(succ);
    }
  }
  // Safety net: if a cycle slipped through condensation, append the rest stably.
  if (out.length < blockedBy.size) {
    for (const c of [...blockedBy.keys()].sort(pick)) if (!emitted.has(c)) out.push(c);
  }
  return out;
}
