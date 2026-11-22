import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepo } from "../scan.ts";
import type { CodeGraph } from "../graph/types.ts";

let root: string;
let graph: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-py-"));
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "pkg", "__init__.py"),
    "",
  );
  fs.writeFileSync(
    path.join(root, "pkg", "utils.py"),
    "def compute():\n    return 1\n\n\ndef helper():\n    return 2\n",
  );
  fs.writeFileSync(
    path.join(root, "pkg", "main.py"),
    [
      "from .utils import compute, helper as h",
      "from . import utils",
      "",
      "compute()  # module-level call",
      "",
      "def run():",
      "    compute()",
      "    h()",
      "    utils.helper()",
      "    utils.nonexistent()  # not a real symbol → must be filtered",
      "",
    ].join("\n"),
  );
  graph = await scanRepo(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function callsTo(fromSymbol: string) {
  return graph.calls
    .filter((c) => c.from === "pkg/main.py" && c.fromSymbol === fromSymbol)
    .map((c) => `${c.to}#${c.toSymbol}`)
    .sort();
}

describe("python call edges", () => {
  test("resolves `from mod import name` calls", () => {
    expect(callsTo("run")).toContain("pkg/utils.py#compute");
  });

  test("resolves aliased imports to the original symbol", () => {
    // `helper as h` → calling h() targets helper.
    expect(callsTo("run")).toContain("pkg/utils.py#helper");
  });

  test("resolves module-qualified calls (`from . import utils; utils.helper()`)", () => {
    expect(callsTo("run")).toContain("pkg/utils.py#helper");
  });

  test("tracks the enclosing function, including module level", () => {
    expect(callsTo("<module>")).toContain("pkg/utils.py#compute");
  });

  test("filters calls to symbols not declared in the target file", () => {
    const all = graph.calls.map((c) => `${c.toSymbol}`);
    expect(all).not.toContain("nonexistent");
  });

  test("call edges only point at scanned files", () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const c of graph.calls) expect(ids.has(c.to)).toBe(true);
  });
});
