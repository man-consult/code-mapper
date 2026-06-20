import { useEffect, useMemo, useState } from "react";
import { Graph } from "./Graph.tsx";
import { buildCallGraph } from "./callgraph.ts";
import { buildAdjacency, reachable } from "./paths.ts";
import type { CodeGraph, FlowKey, GraphNode, ViewMode } from "./types.ts";

const FLOW_KEYS: FlowKey[] = ["writes", "reads", "auth"];

/** A base URL pointing at the local machine (so nothing leaves it). */
function isLocalUrl(url: string): boolean {
  return /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url.trim());
}

/** Host shown in the data-egress warning. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host || url;
  } catch {
    return url.trim() || "the endpoint";
  }
}

export function App() {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("files");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flows, setFlows] = useState<Set<FlowKey>>(new Set());
  const [hideIsolated, setHideIsolated] = useState(true);

  // Annotation (only available when served by `codemap serve`). The API key
  // lives in component state only — never localStorage/sessionStorage.
  const [backend, setBackend] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickerPath, setPickerPath] = useState("");
  const [pickerParent, setPickerParent] = useState<string | null>(null);
  const [pickerEntries, setPickerEntries] = useState<{ name: string; path: string }[]>([]);
  const [pickerErr, setPickerErr] = useState<string | null>(null);
  const [annBaseUrl, setAnnBaseUrl] = useState("http://localhost:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [annModel, setAnnModel] = useState("");
  const [annotating, setAnnotating] = useState(false);
  const [annMsg, setAnnMsg] = useState<string | null>(null);

  // Best-effort auto-load of a graph.json served alongside the app.
  useEffect(() => {
    fetch("./graph.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((g: CodeGraph) => setGraph(g))
      .catch(() => {});
  }, []);

  // Detect whether a `codemap serve` backend is present.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(() => setBackend(true))
      .catch(() => setBackend(false));
  }, []);

  const callGraph = useMemo(() => (graph ? buildCallGraph(graph) : null), [graph]);
  const hasCalls = (callGraph?.nodes.length ?? 0) > 0;

  // The graph currently being rendered/queried.
  const active = mode === "functions" && callGraph ? callGraph : graph;

  const adjacency = useMemo(() => (active ? buildAdjacency(active) : null), [active]);
  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    active?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [active]);

  const downstream = useMemo(
    () => (selected && adjacency ? reachable(adjacency.forward, selected) : new Set<string>()),
    [selected, adjacency],
  );
  const upstream = useMemo(
    () => (selected && adjacency ? reachable(adjacency.reverse, selected) : new Set<string>()),
    [selected, adjacency],
  );

  const matched = useMemo(() => {
    if (!active) return null;
    const q = query.trim().toLowerCase();
    const flowActive = flows.size > 0;
    if (!q && !flowActive) return null;
    const set = new Set<string>();
    for (const n of active.nodes) {
      const qOk = !q || n.id.toLowerCase().includes(q);
      const fOk = !flowActive || [...flows].some((k) => (n.annotation?.[k]?.length ?? 0) > 0);
      if (qOk && fOk) set.add(n.id);
    }
    return set;
  }, [active, query, flows]);

  // Files with no import/call edges — d3 flings these into a useless outer ring,
  // so they're hidden by default.
  const isolatedCount = useMemo(() => {
    if (!active) return 0;
    const connected = new Set<string>();
    for (const e of active.edges) {
      connected.add(e.from);
      connected.add(e.to);
    }
    return active.nodes.reduce((n, node) => n + (connected.has(node.id) ? 0 : 1), 0);
  }, [active]);

  // Flow trace: union the semantic layer (writes/reads/auth) across the selected
  // file + everything it depends on — the full data footprint of the capability.
  const flowTrace = useMemo(() => {
    if (!selected) return null;
    const ids = new Set<string>([selected, ...downstream]);
    const writes = new Set<string>();
    const reads = new Set<string>();
    const config = new Set<string>();
    const auth = new Set<string>();
    let annotated = 0;
    for (const id of ids) {
      const a = nodeById.get(id)?.annotation;
      if (!a) continue;
      annotated++;
      a.writes.forEach((x) => writes.add(x));
      a.reads.forEach((x) => reads.add(x));
      a.config?.forEach((x) => config.add(x));
      a.auth.forEach((x) => auth.add(x));
    }
    if (annotated === 0) return null;
    return {
      files: ids.size,
      writes: [...writes].sort(),
      reads: [...reads].sort(),
      config: [...config].sort(),
      auth: [...auth].sort(),
    };
  }, [selected, downstream, nodeById]);

  function loadFile(file: File) {
    file
      .text()
      .then((t) => JSON.parse(t) as CodeGraph)
      .then((g) => {
        if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("not a code-mapper graph");
        setGraph(g);
        setSelected(null);
        setError(null);
      })
      .catch(() => setError("Could not parse that file as a code-mapper graph.json."));
  }

  function switchMode(next: ViewMode) {
    setMode(next);
    setSelected(null);
  }

  async function openPicker() {
    setPicking(true);
    await loadLs(scanPath.trim() || undefined);
  }

  async function loadLs(p?: string) {
    setPickerErr(null);
    try {
      const res = await fetch(p ? `/api/ls?path=${encodeURIComponent(p)}` : "/api/ls");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cannot list directory.");
      setPickerPath(data.path);
      setPickerParent(data.parent);
      setPickerEntries(data.entries);
    } catch (e) {
      setPickerErr((e as Error).message);
    }
  }

  function scanHere() {
    setPicking(false);
    void runScan(pickerPath);
  }

  async function runScan(pathArg?: string) {
    const p = (pathArg ?? scanPath).trim();
    if (!p) {
      setScanMsg("Enter a directory path to scan.");
      return;
    }
    setScanPath(p);
    setScanning(true);
    setScanMsg("Scanning…");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Scan failed.");
      setScanMsg(`${data.nodes} files · ${data.edges} imports · ${data.calls} calls`);
      const g = (await (await fetch("./graph.json")).json()) as CodeGraph;
      setGraph(g);
      setSelected(null);
      setMode("files");
      setAnnMsg(null);
    } catch (e) {
      setScanMsg((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function runAnnotate() {
    if (!annModel.trim()) {
      setAnnMsg("Enter a model name.");
      return;
    }
    const local = isLocalUrl(annBaseUrl);
    setAnnotating(true);
    setAnnMsg(
      local ? "Annotating locally… this can take a moment." : "Annotating… this can take a moment.",
    );
    try {
      const res = await fetch("/api/annotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: annBaseUrl.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
          model: annModel.trim(),
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Annotation failed.");
      }

      // Read the NDJSON progress stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalMsg = "Done.";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const evt = JSON.parse(line) as {
            type: string;
            done?: number;
            total?: number;
            file?: string;
            message?: string;
            error?: string;
          };
          if (evt.type === "progress") {
            const name = evt.file?.split("/").pop() ?? "";
            setAnnMsg(`Annotating ${evt.done}/${evt.total} — ${name}`);
          } else if (evt.type === "done") {
            finalMsg = evt.message ?? "Done.";
          } else if (evt.type === "error") {
            throw new Error(evt.error ?? "Annotation failed.");
          }
        }
      }

      setAnnMsg(finalMsg);
      const g = (await (await fetch("./graph.json")).json()) as CodeGraph;
      setGraph(g);
    } catch (e) {
      setAnnMsg((e as Error).message);
    } finally {
      setAnnotating(false);
    }
  }

  function toggleFlow(k: FlowKey) {
    setFlows((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const downLabel = mode === "functions" ? "calls" : "downstream";
  const upLabel = mode === "functions" ? "callers" : "upstream";

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) loadFile(f);
      }}
    >
      <aside className="sidebar">
        <h1>code-mapper</h1>

        {backend ? (
          <div className="scan-panel">
            <span className="muted">Scan a directory</span>
            <input
              className="search"
              placeholder="/path/to/your/repo"
              value={scanPath}
              spellCheck={false}
              onChange={(e) => setScanPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runScan()}
            />
            <div className="scan-actions">
              <button className="browse-btn" onClick={openPicker}>
                Browse…
              </button>
              <button className="scan-btn" disabled={scanning} onClick={() => runScan()}>
                {scanning ? "Scanning…" : "Scan"}
              </button>
            </div>
            {scanMsg && <p className="muted ann-msg">{scanMsg}</p>}
          </div>
        ) : (
          <label className="file-btn">
            Load graph.json
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}

        <div className="mode-toggle">
          <button
            className={mode === "files" ? "on" : ""}
            onClick={() => switchMode("files")}
          >
            Files
          </button>
          <button
            className={mode === "functions" ? "on" : ""}
            disabled={!hasCalls}
            title={hasCalls ? "" : "No call edges in this graph (TS/JS only)"}
            onClick={() => switchMode("functions")}
          >
            Functions
          </button>
        </div>

        <input
          className="search"
          placeholder={mode === "functions" ? "Search functions…" : "Search files…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flow-filters">
          <span className="muted">
            Highlight files that:
            {matched !== null && <span className="match-count"> {matched.size} matched</span>}
          </span>
          {FLOW_KEYS.map((k) => (
            <label key={k}>
              <input type="checkbox" checked={flows.has(k)} onChange={() => toggleFlow(k)} /> {k}
            </label>
          ))}
          {isolatedCount > 0 && (
            <label className="isolated-toggle">
              <input
                type="checkbox"
                checked={!hideIsolated}
                onChange={() => setHideIsolated((v) => !v)}
              />{" "}
              show {isolatedCount} isolated
            </label>
          )}
        </div>

        <div className="annotate-panel">
          <span className="muted">Annotate · OpenAI-compatible</span>
          {backend ? (
            <>
              <input
                className="search"
                placeholder="base URL (e.g. http://localhost:11434/v1)"
                value={annBaseUrl}
                spellCheck={false}
                onChange={(e) => setAnnBaseUrl(e.target.value)}
              />
              <input
                className="search"
                type="password"
                placeholder="API key (blank for local)"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <input
                className="search"
                placeholder="model (required, e.g. qwen2.5-coder:7b)"
                value={annModel}
                spellCheck={false}
                onChange={(e) => setAnnModel(e.target.value)}
              />
              {isLocalUrl(annBaseUrl) ? (
                <p className="muted ann-note">
                  Local endpoint — nothing leaves your machine. Needs the server running with the
                  model pulled.
                </p>
              ) : (
                <p className="ann-warning">
                  ⚠️ Sends the full contents of every scanned file to{" "}
                  <strong>{hostOf(annBaseUrl)}</strong>. Don’t annotate proprietary code you’re not
                  cleared to share.
                </p>
              )}
              <button className="annotate-btn" disabled={annotating} onClick={runAnnotate}>
                {annotating ? "Annotating…" : isLocalUrl(annBaseUrl) ? "Annotate (local)" : "Annotate"}
              </button>
              {annMsg && <p className="muted ann-msg">{annMsg}</p>}
            </>
          ) : (
            <p className="muted">
              Run <code>codemap serve &lt;vault&gt;</code> to annotate from the browser.
            </p>
          )}
        </div>

        {active && (
          <p className="muted stats">
            {active.nodes.length} {mode === "functions" ? "functions" : "files"} ·{" "}
            {active.edges.length} {mode === "functions" ? "calls" : "edges"}
          </p>
        )}

        {selectedNode ? (
          <>
            <NodeDetails
              node={selectedNode}
              downLabel={downLabel}
              upLabel={upLabel}
              downstream={downstream.size}
              upstream={upstream.size}
            />
            {flowTrace && (
              <div className="flow-trace">
                <h3>Flow trace · this + {flowTrace.files - 1} {downLabel}</h3>
                <FlowList label="Writes" items={flowTrace.writes} />
                <FlowList label="Reads" items={flowTrace.reads} />
                <FlowList label="Config" items={flowTrace.config} />
                <FlowList label="Auth" items={flowTrace.auth} />
              </div>
            )}
          </>
        ) : (
          <p className="hint">
            Click a node to highlight what it {downLabel === "calls" ? "calls" : "depends on"} (
            {downLabel}) and what {upLabel === "callers" ? "calls it" : "depends on it"} ({upLabel}).
            Scroll to zoom, drag to pan.
          </p>
        )}
      </aside>

      <main className="canvas">
        {active ? (
          <Graph
            graph={active}
            selected={selected}
            downstream={downstream}
            upstream={upstream}
            matched={matched}
            hideIsolated={hideIsolated}
            onSelect={setSelected}
          />
        ) : (
          <div className="empty">
            {backend ? (
              <>
                <p>Enter a repo path in the sidebar and click <strong>Scan</strong> to map it.</p>
                <p className="muted">The graph and Obsidian vault are written to <code>&lt;repo&gt;/.codemap</code>.</p>
              </>
            ) : (
              <>
                <p>Drop a <code>.codemap/graph.json</code> here, or use “Load graph.json”.</p>
                <p className="muted">Or launch the full UI with <code>codemap serve</code>.</p>
              </>
            )}
          </div>
        )}
      </main>

      {picking && (
        <div className="picker-overlay" onClick={() => setPicking(false)}>
          <div className="picker" onClick={(e) => e.stopPropagation()}>
            <div className="picker-head">
              <span className="picker-path" title={pickerPath}>
                {pickerPath || "…"}
              </span>
              <button className="scan-btn" disabled={!pickerPath} onClick={scanHere}>
                Scan this folder
              </button>
            </div>
            {pickerErr && <p className="error">{pickerErr}</p>}
            <ul className="picker-list">
              <li className="picker-row picker-up" onClick={() => loadLs("~")}>
                🏠 Home
              </li>
              {pickerParent && (
                <li className="picker-row picker-up" onClick={() => loadLs(pickerParent)}>
                  ⬆ ..
                </li>
              )}
              {pickerEntries.map((e) => (
                <li className="picker-row" key={e.path} onClick={() => loadLs(e.path)}>
                  📁 {e.name}
                </li>
              ))}
              {pickerEntries.length === 0 && <li className="picker-row muted">(no subfolders)</li>}
            </ul>
            <button className="picker-cancel" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeDetails(props: {
  node: GraphNode;
  downLabel: string;
  upLabel: string;
  downstream: number;
  upstream: number;
}) {
  const { node, downLabel, upLabel, downstream, upstream } = props;
  const a = node.annotation;
  const isSymbol = node.id.includes("#");
  const title = isSymbol ? node.id.slice(node.id.indexOf("#") + 1) : node.path;
  const subtitle = isSymbol ? node.id.slice(0, node.id.indexOf("#")) : node.language;

  return (
    <div className="details">
      <h2>{title}</h2>
      <p className="muted">
        {subtitle} · {downstream} {downLabel} · {upstream} {upLabel}
      </p>
      {a?.summary && <p>{a.summary}</p>}
      <FlowList label="Writes" items={a?.writes} />
      <FlowList label="Reads" items={a?.reads} />
      <FlowList label="Config" items={a?.config} />
      <FlowList label="Auth" items={a?.auth} />
      <FlowList label="Flow" items={a?.flows} />
      {node.symbols.length > 0 && (
        <FlowList label="Symbols" items={node.symbols.map((s) => s.name)} />
      )}
      {!a && <p className="muted">No annotations — run <code>codemap annotate</code>.</p>}
    </div>
  );
}

function FlowList(props: { label: string; items?: string[] }) {
  if (!props.items || props.items.length === 0) return null;
  return (
    <div className="flow-list">
      <h3>{props.label}</h3>
      <ul>
        {props.items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
