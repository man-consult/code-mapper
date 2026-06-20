import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Annotation } from "@codemap/core";

/**
 * Bump when the annotation schema or prompt changes — it's part of the cache
 * key, so old entries miss and files get re-annotated with the new format.
 */
export const ANNOTATION_SCHEMA_VERSION = "2";

/**
 * On-disk annotation cache keyed by sha256(schemaVersion + model + source).
 * Stores ONLY model output — never API keys, prompts, or other secrets. Lets
 * re-runs skip unchanged files (and avoids re-sending their contents to the LLM).
 */
export class AnnotationCache {
  private readonly file: string;
  private data: Record<string, Annotation> = {};

  constructor(cacheDir: string) {
    this.file = path.join(cacheDir, "annotations.json");
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  static key(model: string, source: string): string {
    return createHash("sha256")
      .update(ANNOTATION_SCHEMA_VERSION)
      .update("\0")
      .update(model)
      .update("\0")
      .update(source)
      .digest("hex");
  }

  get(key: string): Annotation | undefined {
    return this.data[key];
  }

  set(key: string, annotation: Annotation): void {
    this.data[key] = annotation;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
