import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepo, writeVault } from "@codemap/core";
import { annotateGraph, OpenAICompatAnnotator } from "@codemap/annotate";

/** Expand a leading ~ to the user's home directory before resolving. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface ServeOptions {
  port?: number;
  webDir?: string;
}

/**
 * Defend the loopback server against DNS-rebinding and cross-site requests: a
 * remote page can resolve its own domain to 127.0.0.1, but the browser still
 * sends that domain in `Host`/`Origin`. Only requests that are genuinely
 * addressed to localhost are allowed; everything else is refused.
 * Returns a 403 Response to send back, or null when the request is allowed.
 */
function guardLocal(req: Request, port: number): Response | null {
  const allowedHosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);

  const host = req.headers.get("host");
  if (!host || !allowedHosts.has(host)) {
    return new Response("Forbidden: unexpected Host header.", { status: 403 });
  }

  // If an Origin is present (cross-site fetches always carry one), its host
  // must also be a localhost origin on this port.
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return new Response("Forbidden: malformed Origin.", { status: 403 });
    }
    if (!allowedHosts.has(originHost)) {
      return new Response("Forbidden: cross-origin request blocked.", { status: 403 });
    }
  }

  return null;
}

/**
 * Serialize mutating operations (scan/annotate) so two concurrent requests
 * never read-modify-write the same vault at once. A single promise chain is
 * sufficient for this single-user local tool.
 */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    // Keep the chain alive regardless of this op's success/failure.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Local helper server (loopback only) that drives the whole tool from the
 * browser: scan a directory, annotate it, and explore — all via the web UI.
 * The only CLI step is launching this. Source reads stay contained to the
 * chosen root; the Mistral key is used transiently and never persisted/logged.
 */
export async function serve(vaultInput: string | undefined, opts: ServeOptions = {}): Promise<void> {
  const webDir = opts.webDir ? path.resolve(opts.webDir) : resolveWebDir();
  await ensureWebBuilt(webDir);

  // Mutable server state — the vault currently loaded/scanned.
  let currentVault: string | null = null;
  if (vaultInput) {
    const v = path.resolve(vaultInput);
    if (fs.existsSync(path.join(v, "graph.json"))) currentVault = v;
    else console.warn(`No graph.json in ${v} yet — scan a directory from the UI.`);
  }

  const port = opts.port ?? 4321;

  // Serializes vault-mutating requests (scan/annotate) to avoid lost updates.
  const withVaultLock = createMutex();

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    // Disabled: the annotate progress stream can sit quiet for >10s while a
    // single large file is processed; the default 10s idle timeout would drop it.
    idleTimeout: 0,
    async fetch(req) {
      const blocked = guardLocal(req, port);
      if (blocked) return blocked;

      const { pathname } = new URL(req.url);

      if (pathname === "/api/health") {
        return Response.json({ ok: true, vault: currentVault });
      }
      if (pathname === "/graph.json") {
        if (!currentVault) return new Response("No vault scanned yet.", { status: 404 });
        return new Response(Bun.file(path.join(currentVault, "graph.json")), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (pathname === "/api/ls") {
        return handleLs(new URL(req.url).searchParams.get("path"));
      }
      if (pathname === "/api/scan" && req.method === "POST") {
        return withVaultLock(async () => {
          const { response, vault } = await handleScan(req);
          if (vault) currentVault = vault;
          return response;
        });
      }
      if (pathname === "/api/annotate" && req.method === "POST") {
        // Streams progress; acquires the vault lock internally so it's held for
        // the whole annotation (not released when the Response is returned).
        return handleAnnotate(req, currentVault, withVaultLock);
      }
      return serveStatic(webDir, pathname);
    },
  });

  console.log(`code-mapper UI → http://localhost:${port}`);
  if (currentVault) console.log(`  vault: ${currentVault}`);
  else console.log("  scan a directory from the browser to begin");
}

/** Read-only directory listing for the UI's folder picker (subdirectories only). */
function handleLs(query: string | null): Response {
  const target = query?.trim() ? expandHome(query.trim()) : process.cwd();
  const dir = path.resolve(target);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return Response.json({ error: `Cannot access: ${dir}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${dir}` }, { status: 400 });
  }

  let entries: { name: string; path: string }[] = [];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        try {
          if (e.isDirectory()) return true;
          // Follow symlinks that point at directories.
          return e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory();
        } catch {
          return false; // unreadable / dangling — skip
        }
      })
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const parent = path.dirname(dir);
  return Response.json({ path: dir, parent: parent === dir ? null : parent, entries });
}

async function handleScan(req: Request): Promise<{ response: Response; vault?: string }> {
  let body: { path?: string; out?: string };
  try {
    body = (await req.json()) as { path?: string; out?: string };
  } catch {
    return { response: Response.json({ error: "Invalid JSON body." }, { status: 400 }) };
  }

  const target = body.path?.trim();
  if (!target) {
    return { response: Response.json({ error: "A directory path is required." }, { status: 400 }) };
  }

  const root = path.resolve(expandHome(target));
  if (!fs.existsSync(root)) {
    return { response: Response.json({ error: `Path not found: ${root}` }, { status: 400 }) };
  }
  if (!fs.statSync(root).isDirectory()) {
    return { response: Response.json({ error: `Not a directory: ${root}` }, { status: 400 }) };
  }

  const out = body.out?.trim() ? path.resolve(body.out) : path.join(root, ".codemap");
  try {
    const graph = await scanRepo(root, { outDirName: path.basename(out) });
    const { files } = writeVault(graph, out);
    return {
      response: Response.json({
        files,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        calls: graph.calls.length,
        vault: out,
      }),
      vault: out,
    };
  } catch (err) {
    return { response: Response.json({ error: (err as Error).message }, { status: 500 }) };
  }
}

async function handleAnnotate(
  req: Request,
  currentVault: string | null,
  lock: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<Response> {
  if (!currentVault) {
    return Response.json({ error: "Scan a directory first." }, { status: 400 });
  }

  let body: { baseUrl?: string; apiKey?: string; model?: string };
  try {
    body = (await req.json()) as { baseUrl?: string; apiKey?: string; model?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const model = body.model?.trim();
  if (!model) {
    return Response.json({ error: "A model name is required." }, { status: 400 });
  }
  // Any OpenAI-compatible endpoint. Defaults to local Ollama; a hosted base URL
  // (+ key) sends the code there instead.
  const baseUrl = body.baseUrl?.trim() || "http://localhost:11434/v1";
  const apiKey = body.apiKey?.trim() || undefined;
  const isLocal = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
  // Local: one at a time (each parallel request is another model context in RAM).
  // Hosted: a little parallelism — it's the provider's compute, not local memory.
  const concurrency = isLocal ? 1 : 4;

  // Stream newline-delimited JSON: {type:"progress",done,total,file}* then
  // {type:"done",...result,message} (or {type:"error",error}).
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
      try {
        await lock(async () => {
          const annotator = new OpenAICompatAnnotator({ baseUrl, model, apiKey });
          const result = await annotateGraph(currentVault, annotator, {
            concurrency,
            onProgress: (done, total, file) => send({ type: "progress", done, total, file }),
          });
          const message =
            result.total > 0 && result.failed === result.total
              ? isLocal
                ? `Every file failed — is a server running at ${baseUrl}? (e.g. \`ollama serve\` + \`ollama pull ${model}\`)`
                : `Every file failed — check the base URL, API key, and model (${model}).`
              : `Annotated ${result.annotated}, cached ${result.cached}, failed ${result.failed} (${model}).`;
          send({ type: "done", ...result, model, message });
        });
      } catch (err) {
        send({ type: "error", error: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

function serveStatic(webDir: string, pathname: string): Response {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(webDir, rel);

  // Containment: never serve outside the web dist dir.
  if (resolved !== webDir && !resolved.startsWith(webDir + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return new Response(Bun.file(resolved));
  }
  return new Response(Bun.file(path.join(webDir, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}

/**
 * Locate the built web UI. Works both from the monorepo source
 * (packages/cli/src → packages/web/dist) and from an installed package
 * (bin/ → ../web), where the UI is shipped prebuilt.
 */
function resolveWebDir(): string {
  const candidates = [
    path.resolve(import.meta.dir, "../../web/dist"), // dev: packages/cli/src
    path.resolve(import.meta.dir, "../web"), // published: <pkg>/bin
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}

async function ensureWebBuilt(webDir: string): Promise<void> {
  if (fs.existsSync(path.join(webDir, "index.html"))) return;

  // Installed packages ship the UI prebuilt; only the monorepo can build it.
  const webPkg = path.resolve(webDir, "..");
  if (!fs.existsSync(path.join(webPkg, "vite.config.ts"))) {
    throw new Error(`Web UI assets missing at ${webDir}. Try reinstalling code-mapper.`);
  }
  console.log("Building web UI (first run)…");
  const proc = Bun.spawn(["bunx", "vite", "build", webPkg], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0 || !fs.existsSync(path.join(webDir, "index.html"))) {
    throw new Error(`Failed to build the web UI at ${webPkg}.`);
  }
}
