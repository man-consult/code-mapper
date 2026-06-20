import { z } from "zod";
import type { Annotation } from "@codemap/core";

/** Validates raw model output; tolerant of missing arrays via defaults. */
export const AnnotationSchema = z.object({
  summary: z.string().catch(""),
  writes: z.array(z.string()).catch([]),
  reads: z.array(z.string()).catch([]),
  config: z.array(z.string()).catch([]),
  auth: z.array(z.string()).catch([]),
  flows: z.array(z.string()).catch([]),
});

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
