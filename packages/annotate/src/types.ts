import type { Annotation } from "@codemap/core";

const LIST_FIELDS = ["writes", "reads", "config", "auth", "flows"] as const;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validates raw model output. Must be a JSON object; any field that is missing
 * or the wrong shape falls back to its empty default, and unknown keys are
 * dropped (so a model can't smuggle extra fields into graph.json).
 */
export function validateAnnotation(raw: unknown): Annotation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Model output is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const out = { summary: typeof o.summary === "string" ? o.summary : "" } as Annotation;
  for (const k of LIST_FIELDS) out[k] = isStringArray(o[k]) ? o[k] : [];
  return out;
}

export interface AnnotateInput {
  id: string;
  language: string;
  source: string;
  dependencies: string[];
  dependents: string[];
}

export interface Annotator {
  /** Resolved model id (used as part of the cache key). */
  readonly model: string;
  annotate(input: AnnotateInput): Promise<Annotation>;
}
