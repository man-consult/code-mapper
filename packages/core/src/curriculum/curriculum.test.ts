import { describe, expect, test } from "bun:test";
import { buildCurriculum } from "./curriculum.ts";
import type { CodeGraph, GraphEdge } from "../graph/types.ts";

function file(id: string, symbols: string[] = ["x"]) {
  return { id, path: id, language: "typescript" as const, symbols: symbols.map((name) => ({ name, kind: "fn" })) };
}
function imp(from: string, to: string): GraphEdge {
  return { from, to, kind: "import" };
}
function graph(nodes: ReturnType<typeof file>[], edges: GraphEdge[]): CodeGraph {
  return { root: "/repo", nodes, edges, calls: [] };
}

/** Position of a file id in the flattened tour order. */
function orderOf(cur: ReturnType<typeof buildCurriculum>, id: string): number | null {
  for (const ch of cur.chapters) for (const s of ch.stops) if (s.id === id) return s.order;
  return null;
}
function stopOf(cur: ReturnType<typeof buildCurriculum>, id: string) {
  for (const ch of cur.chapters) for (const s of ch.stops) if (s.id === id) return s;
  return null;
}

describe("buildCurriculum", () => {
  test("orders dependencies before dependents within a module", () => {
    // src/a imports src/b imports src/c  →  c, then b, then a.
    const g = graph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [imp("src/a.ts", "src/b.ts"), imp("src/b.ts", "src/c.ts")],
    );
    const cur = buildCurriculum(g, { spineSize: 0 });
    expect(orderOf(cur, "src/c.ts")!).toBeLessThan(orderOf(cur, "src/b.ts")!);
    expect(orderOf(cur, "src/b.ts")!).toBeLessThan(orderOf(cur, "src/a.ts")!);
  });

  test("seenDeps reflect what was already introduced", () => {
    const g = graph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [imp("src/a.ts", "src/b.ts"), imp("src/b.ts", "src/c.ts")],
    );
    const cur = buildCurriculum(g, { spineSize: 0 });
    // By the time we reach `a`, both b and c are already seen.
    const a = stopOf(cur, "src/a.ts")!;
    expect(a.seenDeps).toContain("src/b.ts");
    expect(a.newDeps).toEqual([]);
    // c is first — depends on nothing.
    const c = stopOf(cur, "src/c.ts")!;
    expect(c.seenDeps).toEqual([]);
    expect(c.role).toBe("foundation");
  });

  test("folds an import cycle into a cluster", () => {
    const g = graph(
      [file("src/x.ts"), file("src/y.ts")],
      [imp("src/x.ts", "src/y.ts"), imp("src/y.ts", "src/x.ts")],
    );
    const cur = buildCurriculum(g, { spineSize: 0 });
    expect(cur.cycles).toBe(1);
    expect(stopOf(cur, "src/x.ts")!.cluster).toContain("src/y.ts");
    expect(stopOf(cur, "src/y.ts")!.cluster).toContain("src/x.ts");
  });

  test("excludes tests and generated files, and reports them", () => {
    const g = graph(
      [
        file("src/a.ts"),
        file("src/a.test.ts"),
        file("src/types.d.ts"),
        file("src/__tests__/helper.ts"),
      ],
      [],
    );
    const cur = buildCurriculum(g, { spineSize: 0 });
    expect(orderOf(cur, "src/a.test.ts")).toBeNull();
    expect(orderOf(cur, "src/types.d.ts")).toBeNull();
    expect(orderOf(cur, "src/__tests__/helper.ts")).toBeNull();
    expect(cur.excluded.tests).toBe(2);
    expect(cur.excluded.generated).toBe(1);
    expect(cur.totalFiles).toBe(1);
  });

  test("surfaces a heavily-imported hub into the spine chapter", () => {
    // db.ts is imported by 3 files → high centrality → spine landmark.
    const g = graph(
      [file("src/db.ts"), file("src/u.ts"), file("src/v.ts"), file("src/w.ts")],
      [imp("src/u.ts", "src/db.ts"), imp("src/v.ts", "src/db.ts"), imp("src/w.ts", "src/db.ts")],
    );
    const cur = buildCurriculum(g, { spineSize: 7 });
    const spine = cur.chapters.find((c) => c.kind === "spine");
    expect(spine).toBeDefined();
    expect(spine!.stops.map((s) => s.id)).toContain("src/db.ts");
    expect(stopOf(cur, "src/db.ts")!.dependedOnBy).toBe(3);
  });

  test("entrypoints mode inverts the reading order", () => {
    // a → b → c. Foundations: c,b,a. Entrypoints: a,b,c.
    const g = graph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [imp("src/a.ts", "src/b.ts"), imp("src/b.ts", "src/c.ts")],
    );
    const found = buildCurriculum(g, { spineSize: 0, order: "foundations" });
    const entry = buildCurriculum(g, { spineSize: 0, order: "entrypoints" });
    expect(found.order).toBe("foundations");
    expect(entry.order).toBe("entrypoints");
    // c (leaf dependency) before a (entry) in foundations; reversed in entrypoints.
    expect(orderOf(found, "src/c.ts")!).toBeLessThan(orderOf(found, "src/a.ts")!);
    expect(orderOf(entry, "src/a.ts")!).toBeLessThan(orderOf(entry, "src/c.ts")!);
    // In entrypoints mode, the entry file's deps are all still coming up.
    expect(stopOf(entry, "src/a.ts")!.seenDeps).toEqual([]);
    expect(stopOf(entry, "src/a.ts")!.newDeps).toContain("src/b.ts");
  });

  test("is deterministic — same graph in, identical curriculum out", () => {
    const build = () =>
      buildCurriculum(
        graph(
          [file("src/a.ts"), file("src/b.ts"), file("lib/c.ts")],
          [imp("src/a.ts", "src/b.ts"), imp("src/a.ts", "lib/c.ts")],
        ),
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
