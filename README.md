# code-mapper

Map your codebase's **dependencies** and **data flows** (writes / reads / auth) into an
Obsidian-linkable Markdown vault, with a web UI to navigate and highlight paths.

> Open source (MIT). Hybrid architecture: deterministic static analysis builds the graph,
> an open-weight LLM adds the semantic layer.
>
> ⚠️ **Early / experimental** — interfaces and output format may change.

## Why this exists

I wanted to get better at reading code I didn't write. Two kinds, really. The first: understanding the code an LLM wrote for me. Generating it is the fast part. Getting across what it actually did (what it touched, what it reads and writes, whether the auth path is where I think it is) was the gap I needed to fix. This tool is my way of improving the verification step. Generate, then graph it and see what's really there.

The second is dropping into an unfamiliar repo and tracing how it stitches together, what calls what, where data gets written, which paths run through auth. Slow work, and easy to get wrong when it's not your local playground. This part is all about learning good patterns from people who know what they're doing.

It's experimental because it was built to be useful to me first, not to be a finished product. If it helps you better understand a codebase the same way, good.


## Requirements

- [Bun](https://bun.sh) ≥ 1.0 — the runtime (the tool uses Bun's built-in server).
- *(optional, for the annotation layer)* a local [Ollama](https://ollama.com) install, or a
  Mistral / OpenAI API key. The graph itself needs no model.

## Install

No clone needed:

```bash
bunx code-mapper serve        # opens http://localhost:4321
```

Then, in the browser: **Browse** to a repo → **Scan** → explore. Optionally paste a Mistral API
key and click **Annotate** for the semantic layer. (See [Usage](#usage) for the full walkthrough.)

## How it works

```
AST / static analysis  →  import graph + function-level call graph   (deterministic, no tokens)
        ↓
   LLM annotation       →  writes / reads / auth / flows              (provider-agnostic; default: local Ollama)
        ↓
   Markdown vault       →  one .md per file, [[wikilinks]] = real edges   (link into Obsidian)
        ↓
   Web UI               →  Files / Functions views, highlight up/downstream paths, filter by flow
```

## Status

| Phase | What | State |
|-------|------|-------|
| 1 | Core graph (TS/JS via ts-morph) → `graph.json` + Obsidian vault | ✅ |
| 2 | Tree-sitter Python extractor (imports + symbols, AST-accurate) | ✅ |
| 3 | LLM annotation pass (provider-agnostic, local-first via Ollama) | ✅ |
| 4 | Vite + React web UI over `graph.json` | ✅ |
| 5 | Function-level call graph for TS/JS (`Functions` view) | ✅ |

Python currently contributes import edges + symbols; function-level call edges are TS/JS only.

## Usage

Everything runs from the browser. The only command is launching the UI (`bunx code-mapper serve`,
or `bun run codemap serve` from a source checkout). Then, in the browser:

1. **Scan** — click **Browse…** to pick a folder (or type/paste a path; `~` works), then **Scan**.
   The import graph, call graph, and Obsidian vault are written to `<repo>/.codemap`.
2. **Explore** — toggle **Files / Functions**, click a node to highlight its up/downstream (or
   caller/callee) paths, search, and filter by data-flow type.
3. **Annotate** *(optional)* — paste a **Mistral API key**, click **Annotate** to add the semantic
   layer (summary + writes/reads/auth/flows). The key is held in memory and sent only to your local
   server, which calls Mistral and writes the result back to the vault — never stored in the browser
   or on disk.

Open the same `.codemap/` folder as an Obsidian vault for the graph view + backlinks.
Add `.codemap/` to your `.gitignore` if you don't want it sent to the cloud...

### Scriptable / CI (optional)

The same operations are plain CLI commands, for automation or a local-model workflow:

```bash
bun run codemap scan ./repo -o .codemap            # graph + vault, deterministic, no tokens
ollama pull qwen2.5-coder:7b                        # one-time, ~4.7 GB
bun run codemap annotate -o .codemap               # local Ollama (default)
bun run codemap annotate -o .codemap -p mistral    # Mistral API (needs CODEMAP_API_KEY)
```

### Annotation providers

Annotation hits a real model. Configured by flags or environment; secrets are **read only** from 
the environment and are never written to the vault, `graph.json`, the cache, or logs.

> ⚠️ **Data egress:** annotating sends the **full contents of every scanned file** to the
> configured provider. With `mistral` / `openai` (or any remote `--base-url`) that means your
> source code leaves the machine and is processed by a third party — do not annotate
> proprietary or sensitive code against a remote provider without authorization. For a fully
> local workflow that sends nothing off-box, use the default `ollama` provider.

| Provider | Endpoint | Default model | Key |
|----------|----------|---------------|-----|
| `ollama` (default) | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | none (local) |
| `mistral` | `https://api.mistral.ai/v1` | `devstral-small-2512` | `CODEMAP_API_KEY` / `MISTRAL_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | `CODEMAP_API_KEY` / `OPENAI_API_KEY` |

Env overrides: `CODEMAP_PROVIDER`, `CODEMAP_MODEL`, `CODEMAP_BASE_URL`, `CODEMAP_API_KEY`.
Any OpenAI-compatible endpoint works via `--base-url`. Annotations are cached by file-content
hash under `.codemap/.cache`, so re-runs only re-send changed files.

**Model sizing:** `qwen2.5-coder:7b` (~4.7 GB, Apache-2.0) is the default because it runs on a
16 GB laptop and the per-file task doesn't need more. For higher-quality summaries on a 32 GB+
machine, use `-m devstral` (24B). For 8 GB, `-m qwen2.5-coder:3b`.

## Design notes

- **Graph edges are never inferred by the LLM** — imports come from real module resolution and
  call edges from symbol resolution (TypeScript Compiler API), so they're exact, free, and
  CI-reproducible. The LLM only adds the semantic layer.
- **The LLM is provider-agnostic** behind one `Annotator` interface. Default is local, open-weight
  **Qwen2.5-Coder 7B** (Apache-2.0) via Ollama; Mistral / OpenAI / any OpenAI-compatible endpoint
  are drop-in alternatives via `--provider` / `--base-url`.

## Development

```bash
git clone <repo-url> && cd code-mapper
bun install
bun run codemap serve          # runs from source; rebuilds the UI on first run
```

Monorepo layout (Bun workspaces): `packages/core` (graph extraction), `packages/annotate`
(LLM layer), `packages/cli` (the `serve` command), `packages/web` (Cytoscape UI).
`bun run build:pkg` assembles the publishable `code-mapper` package into `pkg/`.

## License

[MIT](LICENSE) © 2026 Brian Mangano
