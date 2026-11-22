import { describe, expect, test } from "bun:test";
import { parseAnnotation } from "./providers/openai-compat.ts";
import { validateAnnotation } from "./types.ts";

const EMPTY = { summary: "", writes: [], reads: [], config: [], auth: [], flows: [] };

describe("validateAnnotation", () => {
  test("passes a well-formed annotation through", () => {
    const a = { summary: "x", writes: ["db"], reads: [], config: ["ENV"], auth: [], flows: ["a→b"] };
    expect(validateAnnotation(a)).toEqual(a);
  });

  test("missing or wrong-typed fields fall back to defaults", () => {
    expect(validateAnnotation({})).toEqual(EMPTY);
    expect(validateAnnotation({ summary: 42, writes: "db", reads: null })).toEqual(EMPTY);
  });

  test("an array with any non-string item becomes empty", () => {
    expect(validateAnnotation({ writes: ["ok", 1] }).writes).toEqual([]);
  });

  test("unknown keys are dropped", () => {
    expect(Object.keys(validateAnnotation({ summary: "s", extra: "nope", __proto__x: 1 })).sort()).toEqual(
      ["auth", "config", "flows", "reads", "summary", "writes"],
    );
  });

  test("non-object output is rejected", () => {
    for (const bad of [null, [], "text", 3]) expect(() => validateAnnotation(bad)).toThrow();
  });

  test("parseAnnotation recovers JSON embedded in prose", () => {
    expect(parseAnnotation('Sure! ```json\n{"summary":"hi"}\n```').summary).toBe("hi");
  });
});
