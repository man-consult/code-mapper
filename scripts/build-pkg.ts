#!/usr/bin/env bun
/**
 * Assemble the publishable `code-mapper` npm package into ./pkg:
 *  - bundle the CLI (with @codemap/core + @codemap/annotate inlined) into one file
 *  - ship the prebuilt web UI and the README/LICENSE
 *  - declare the runtime-resolved deps (ts-morph / web-tree-sitter / tree-sitter-python)
 *
 * Run: bun run build:pkg   →   then `cd pkg && npm publish`
 */
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const pkg = path.join(root, "pkg");
const VERSION = "0.1.0";

// Externalised: imported at runtime, kept out of the bundle (declared as deps).
// tree-sitter-python is resolved via require.resolve for its .wasm, so it is a
// dependency but never an import to externalise.
const EXTERNALS = ["ts-morph", "web-tree-sitter", "zod", "commander"];

fs.rmSync(pkg, { recursive: true, force: true });
fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });

console.log("• building web UI…");
await $`bunx vite build packages/web`.cwd(root).quiet();

console.log("• bundling CLI…");
await $`bun build packages/cli/src/index.ts --target bun --outfile pkg/bin/code-mapper.js ${EXTERNALS.flatMap(
  (e) => ["--external", e],
)}`.cwd(root);

// Guarantee an executable shebang.
const binPath = path.join(pkg, "bin", "code-mapper.js");
let bin = fs.readFileSync(binPath, "utf8");
if (!bin.startsWith("#!")) bin = `#!/usr/bin/env bun\n${bin}`;
fs.writeFileSync(binPath, bin);
fs.chmodSync(binPath, 0o755);

console.log("• copying web dist + docs…");
fs.cpSync(path.join(root, "packages/web/dist"), path.join(pkg, "web"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(pkg, f));

fs.writeFileSync(
  path.join(pkg, "package.json"),
  `${JSON.stringify(
    {
      name: "codeflowmap",
      version: VERSION,
      description:
        "Map a codebase's dependencies and data flows into an Obsidian-linkable vault and an interactive web UI.",
      type: "module",
      bin: { codeflowmap: "bin/code-mapper.js", codemap: "bin/code-mapper.js" },
      files: ["bin", "web", "README.md", "LICENSE"],
      engines: { bun: ">=1.0.0" },
      dependencies: {
        "ts-morph": "^28.0.0",
        "web-tree-sitter": "^0.26.9",
        "tree-sitter-python": "^0.25.0",
        zod: "^4.4.3",
        commander: "^15.0.0",
      },
      keywords: [
        "code",
        "dependency-graph",
        "call-graph",
        "data-flow",
        "visualization",
        "obsidian",
        "static-analysis",
        "typescript",
        "python",
      ],
      license: "MIT",
      author: "Brian Mangano <brian@mangano.co.nz>",
      homepage: "https://github.com/man-consult/code-mapper#readme",
      repository: { type: "git", url: "git+https://github.com/man-consult/code-mapper.git" },
      bugs: { url: "https://github.com/man-consult/code-mapper/issues" },
    },
    null,
    2,
  )}\n`,
);

console.log(`\n✓ Built ${path.relative(root, pkg)}/  (codeflowmap@${VERSION})`);
console.log("  Test:    cd pkg && bun pm pack");
console.log("  Publish: cd pkg && npm publish   (requires Bun at runtime: bunx codeflowmap)");
