#!/usr/bin/env bun
import path from "node:path";
import { Command } from "commander";
import { scanRepo, writeVault } from "@codemap/core";
import { annotateGraph, createAnnotator, type ProviderName } from "@codemap/annotate";
import { serve } from "./serve.ts";

const program = new Command();

program
  .name("codemap")
  .description("Map your codebase's dependencies and data flows into an Obsidian-linkable vault")
  .version("0.1.0");

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
  .command("serve")
  .description("Launch the web UI — scan, annotate, and explore from the browser")
  .argument("[vault]", "existing vault to open (optional; you can scan from the UI)")
  .option("--port <n>", "port to listen on", "4321")
  .option("--web <dir>", "path to the built web UI (defaults to packages/web/dist)")
  .action(async (vault: string | undefined, options: { port: string; web?: string }) => {
    await serve(vault, { port: Number(options.port), webDir: options.web });
  });

program.parseAsync();
