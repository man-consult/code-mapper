#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { buildCurriculum, scanRepo, writeTour, writeVault, type CodeGraph } from "@codemap/core";
import { annotateGraph, createAnnotator, type ProviderName } from "@codemap/annotate";
import { serve } from "./serve.ts";

const program = new Command();

program
  .name("codemap")
  .description("Map your codebase's dependencies and data flows into an Obsidian-linkable vault")
  .version("0.1.1");

program
  .command("scan")
  .description("Scan a directory and generate the dependency graph + Markdown vault")
  .argument("<dir>", "target directory to scan")
  .option("-o, --out <dir>", "output vault directory", ".codemap")
  .action(async (dir: string, options: { out: string }) => {
    const graph = await scanRepo(dir, { outDirName: path.basename(options.out) });
    const { files, outDir } = writeVault(graph, options.out);
    console.log(`Scanned ${graph.nodes.length} files, ${graph.edges.length} import edges.`);
    console.log(`Wrote ${files} notes + graph.json -> ${outDir}`);
  });

program
  .command("annotate")
  .description("Add the LLM semantic layer (summary, writes/reads/auth/flows) to an existing vault")
  .option("-o, --out <dir>", "vault directory", ".codemap")
  .option("-p, --provider <name>", "ollama | mistral | openai")
  .option("-m, --model <id>", "model id override")
  .option("--base-url <url>", "custom OpenAI-compatible endpoint")
  .action(
    async (options: { out: string; provider?: string; model?: string; baseUrl?: string }) => {
      const annotator = createAnnotator({
        provider: options.provider as ProviderName | undefined,
        model: options.model,
        baseUrl: options.baseUrl,
      });
      console.log(`Annotating vault "${options.out}" with model "${annotator.model}"…`);

      const res = await annotateGraph(options.out, annotator, {
        onProgress: (done, total, id) => {
          const label = id.length > 44 ? `…${id.slice(-43)}` : id.padEnd(44);
          process.stdout.write(`\r  [${done}/${total}] ${label}`);
        },
      });

      process.stdout.write("\n");
      console.log(
        `Done: ${res.annotated} annotated, ${res.cached} cached, ${res.failed} failed (of ${res.total}).`,
      );
    },
  );

program
  .command("onboard")
  .description("Build a guided reading order (TOUR.md) — where to start and what to read next")
  .argument("<dir>", "target directory to onboard into")
  .option("-o, --out <dir>", "vault directory", ".codemap")
  .option("--order <mode>", "reading order: foundations | entrypoints", "foundations")
  .action(async (dir: string, options: { out: string; order: string }) => {
    const order = options.order === "entrypoints" ? "entrypoints" : "foundations";
    const out = path.isAbsolute(options.out) ? options.out : path.join(path.resolve(dir), options.out);
    const graphJson = path.join(out, "graph.json");

    // Reuse an existing graph (keeps any annotations); otherwise scan fresh.
    let graph: CodeGraph;
    if (fs.existsSync(graphJson)) {
      graph = JSON.parse(fs.readFileSync(graphJson, "utf8")) as CodeGraph;
      console.log(`Using existing graph: ${graphJson}`);
    } else {
      graph = await scanRepo(dir, { outDirName: path.basename(out) });
      writeVault(graph, out);
      console.log(`Scanned ${graph.nodes.length} files, ${graph.edges.length} import edges.`);
    }

    const cur = buildCurriculum(graph, { order });
    const { file, stops } = writeTour(cur, out);
    console.log(
      `\nTour (${order} first): ${stops} stops across ${cur.chapters.length} chapters → ${file}`,
    );
    for (const ch of cur.chapters) {
      console.log(`  • ${ch.title} (${ch.stops.length})`);
    }
    if (cur.cycles) console.log(`  ${cur.cycles} import cycle(s) folded.`);
    if (cur.excluded.total) {
      console.log(
        `  skipped ${cur.excluded.total} files (${cur.excluded.tests} test, ${cur.excluded.generated} generated, ${cur.excluded.trivial} inert).`,
      );
    }
  });

program
  .command("serve")
  .description("Launch the web UI — scan, annotate, and explore from the browser")
  .argument("[vault]", "existing vault to open (optional; you can scan from the UI)")
  .option("--port <n>", "port to listen on", "4321")
  .option("--web <dir>", "path to the built web UI (defaults to packages/web/dist)")
  .action(async (vault: string | undefined, options: { port: string; web?: string }) => {
    await serve(vault, { port: Number(options.port), webDir: options.web });
  });

program.parseAsync();
