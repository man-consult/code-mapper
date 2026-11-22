import fs from "node:fs";
import path from "node:path";
import { assertInside, assertSafeOutputDir } from "../util/paths.ts";
import { renderTour } from "./tour-md.ts";
import type { Curriculum } from "./curriculum.ts";

export interface TourResult {
  /** Absolute path to the written TOUR.md. */
  file: string;
  stops: number;
}

/**
 * Write the curriculum as `TOUR.md` inside an existing vault directory. Writes
 * are confined to the vault (same containment guard as the rest of the vault
 * writer): the file name is fixed, but we still assert it resolves inside.
 */
export function writeTour(cur: Curriculum, outDirInput: string): TourResult {
  const outDir = assertSafeOutputDir(outDirInput);
  fs.mkdirSync(outDir, { recursive: true });
  const file = assertInside(outDir, path.join(outDir, "TOUR.md"));
  fs.writeFileSync(file, renderTour(cur));
  return { file, stops: cur.totalStops };
}
