import fs from "node:fs";
import path from "node:path";
import { assertInside, type CodeGraph, writeVault } from "@codemap/core";
import { AnnotationCache } from "./cache.ts";
import type { Annotator } from "./types.ts";

export interface AnnotateResult {
  annotated: number;
  cached: number;
  failed: number;
  total: number;
}

export interface AnnotateOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number, id: string) => void;
}

/**
 * Load an existing vault's graph.json, annotate every node with the LLM
 * semantic layer (using the cache), then rewrite both graph.json and the
 * Markdown vault with the enriched data.
 */
export async function annotateGraph(
  outDir: string,
  annotator: Annotator,
  opts: AnnotateOptions = {},
): Promise<AnnotateResult> {
  const graphPath = path.join(outDir, "graph.json");
  const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as CodeGraph;

  const deps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const e of graph.edges) {
    (deps.get(e.from) ?? deps.set(e.from, []).get(e.from)!).push(e.to);
    (dependents.get(e.to) ?? dependents.set(e.to, []).get(e.to)!).push(e.from);
  }

  const cache = new AnnotationCache(path.join(outDir, ".cache"));
  const result: AnnotateResult = {
    annotated: 0,
    cached: 0,
    failed: 0,
    total: graph.nodes.length,
  };

  const queue = [...graph.nodes];
  let done = 0;
  const workers = Math.max(1, opts.concurrency ?? 4);

  async function worker(): Promise<void> {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      try {
        // Containment guard: refuse ids that escape the recorded scan root.
        const abs = assertInside(graph.root, path.join(graph.root, node.id));
        const source = fs.readFileSync(abs, "utf8");
        const key = AnnotationCache.key(annotator.model, source);

        const hit = cache.get(key);
        if (hit) {
          node.annotation = hit;
          result.cached++;
        } else {
          const annotation = await withRetry(() =>
            annotator.annotate({
              id: node.id,
              language: node.language,
              source,
              dependencies: deps.get(node.id) ?? [],
              dependents: dependents.get(node.id) ?? [],
            }),
          );
          node.annotation = annotation;
          cache.set(key, annotation);
          result.annotated++;
        }
      } catch {
        result.failed++;
      } finally {
        done++;
        opts.onProgress?.(done, result.total, node.id);
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  cache.save();
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  writeVault(graph, outDir);
  return result;
}

/** Retry only on transient failures (network errors or HTTP 429/5xx), with backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryable(err)) throw err;
      // Exponential backoff: 250ms, 500ms, … (jittered to avoid thundering herd).
      const delay = 250 * 2 ** i * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  // No status → network/transport error (fetch rejected): retry.
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}
