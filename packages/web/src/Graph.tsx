import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition, type Stylesheet } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { CodeGraph } from "./types.ts";

let registered = false;
function register() {
  if (registered) return;
  cytoscape.use(fcose);
  registered = true;
}

/** Above this the full-graph layout stops being worth rendering; focus still works. */
const MAX_RENDER_NODES = 3000;
/** A focus side with more members than this is collapsed into directory groups. */
const GROUP_THRESHOLD = 12;

const LANG_COLOR: Record<string, string> = {
  typescript: "#3178c6",
  javascript: "#e6a817",
  python: "#3b7daf",
};

const STYLE: Stylesheet[] = [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      width: 12,
      height: 12,
      label: "data(label)",
      "font-size": 7,
      color: "#d7dce5",
      "text-opacity": 0,
      "text-background-color": "#0f1115",
      "text-background-opacity": 0.7,
      "text-background-padding": "2px",
      "min-zoomed-font-size": 6,
    },
  },
  {
    selector: "edge",
    style: { width: 1, "line-color": "#2c3340", "curve-style": "haystack", opacity: 0.5 },
  },
  {
    selector: "node.sel",
    style: {
      "background-color": "#e6a817",
      width: 20,
      height: 20,
      "text-opacity": 1,
      "border-width": 2,
      "border-color": "#e6a817",
      "z-index": 20,
    },
  },
  { selector: "node.down", style: { "background-color": "#4cc38a", "text-opacity": 1, "z-index": 10 } },
  { selector: "node.up", style: { "background-color": "#e0823d", "text-opacity": 1, "z-index": 10 } },
  {
    selector: "node.match",
    style: { "background-color": "#6ea8fe", width: 16, height: 16, "text-opacity": 1, "z-index": 10 },
  },
  { selector: "node.dim", style: { opacity: 0.12 } },
  { selector: "edge.on", style: { "line-color": "#e6a817", opacity: 0.9, width: 1.6 } },
  { selector: "edge.dim", style: { opacity: 0.06 } },
  // Directory group nodes — distinct pill, overrides the up/down colour.
  {
    selector: "node.grp",
    style: {
      "background-color": "#3a4150",
      shape: "round-rectangle",
      width: "label",
      height: 20,
      padding: "7px",
      "text-opacity": 1,
      "font-size": 9,
      "font-weight": "bold",
      color: "#d7dce5",
      "border-width": 1,
      "border-color": "#5a6b8c",
      "z-index": 15,
    },
  },
  { selector: ".hidden", style: { display: "none" } },
];

export interface GraphProps {
  graph: CodeGraph;
  selected: string | null;
  downstream: Set<string>;
  upstream: Set<string>;
  matched: Set<string> | null;
  hideIsolated: boolean;
  onSelect: (id: string | null) => void;
}

function shortLabel(id: string): string {
  if (id.includes("#")) return id.slice(id.indexOf("#") + 1);
  return id.split("/").pop() ?? id;
}

function dirOf(id: string): string {
  const base = id.includes("#") ? id.slice(0, id.indexOf("#")) : id;
  return base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "(root)";
}

/** Pack a wide set of neighbours into a compact grid block to one side. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gridBlock(eles: any, side: number): void {
  const n = eles.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const cell = 60;
  const gap = 170;
  const w = cols * cell;
  const h = rows * cell;
  const box =
    side < 0
      ? { x1: -(gap + w), y1: -h / 2, x2: -gap, y2: h / 2 }
      : { x1: gap, y1: -h / 2, x2: gap + w, y2: h / 2 };
  eles
    .layout({ name: "grid", cols, boundingBox: box, fit: false, avoidOverlap: true, animate: false })
    .run();
}

/**
 * Position one focus side deterministically: a single column when small, a grid
 * block when wide (even after directory grouping). side: -1 left, +1 right.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placeSide(eles: any, side: number): void {
  const n = eles.length;
  if (n === 0) return;
  if (n > 18) {
    gridBlock(eles, side);
    return;
  }
  const spacing = 48;
  const x = side * 340;
  const startY = -((n - 1) * spacing) / 2;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eles.forEach((nd: any, i: number) => nd.position({ x, y: startY + i * spacing }));
}

export function Graph(props: GraphProps) {
  const { graph, selected, downstream, upstream, matched, hideIsolated, onSelect } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const fullPos = useRef<Map<string, { x: number; y: number }>>(new Map());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const stateRef = useRef({ selected, downstream, upstream, matched, graph });
  stateRef.current = { selected, downstream, upstream, matched, graph };

  // Expanded directory groups (by `${side}:${dir}`) and synthetic element ids.
  const expanded = useRef<Set<string>>(new Set());
  const synthetic = useRef<string[]>([]);
  const applyViewRef = useRef<() => void>(() => {});
  const prevSel = useRef<string | null>(null);

  // --- init cytoscape once ---
  useEffect(() => {
    register();
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLE,
      wheelSensitivity: 0.2,
      minZoom: 0.05,
      maxZoom: 4,
    });
    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      if (n.data("grp")) {
        const key = n.data("key") as string;
        if (expanded.current.has(key)) expanded.current.delete(key);
        else expanded.current.add(key);
        applyViewRef.current();
        return;
      }
      onSelectRef.current(n.id());
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) onSelectRef.current(null);
    });
    cyRef.current = cy;
    (window as unknown as { __cy?: Core }).__cy = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // --- (re)build elements + full layout when the graph or isolated-filter changes ---
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    let nodeList = graph.nodes;
    if (hideIsolated) {
      const connected = new Set<string>();
      for (const e of graph.edges) {
        connected.add(e.from);
        connected.add(e.to);
      }
      nodeList = graph.nodes.filter((n) => connected.has(n.id));
    }
    if (nodeList.length > MAX_RENDER_NODES) {
      cy.elements().remove();
      fullPos.current = new Map();
      return;
    }

    const ids = new Set(nodeList.map((n) => n.id));
    const els: ElementDefinition[] = nodeList.map((n) => ({
      data: { id: n.id, label: shortLabel(n.id), color: LANG_COLOR[n.language] ?? "#5a6b8c" },
    }));
    let i = 0;
    for (const e of graph.edges) {
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
      els.push({ data: { id: `e${i++}`, source: e.from, target: e.to } });
    }

    synthetic.current = [];
    expanded.current = new Set();
    cy.elements().remove();
    cy.add(els);

    const n = nodeList.length;
    cy.layout({
      name: "fcose",
      quality: "default",
      animate: false,
      randomize: true,
      packComponents: true,
      nodeRepulsion: () => (n > 600 ? 4500 : 9000),
      idealEdgeLength: () => (n > 600 ? 50 : 80),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).run();

    fullPos.current = new Map(cy.nodes().map((nd) => [nd.id(), { ...nd.position() }]));
    applyView();
    cy.fit(undefined, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, hideIsolated]);

  // --- re-apply highlight / focus when selection or filters change ---
  useEffect(() => {
    if (prevSel.current !== selected) {
      expanded.current = new Set();
      prevSel.current = selected;
    }
    applyView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, downstream, upstream, matched]);

  function neighborhoodIds(): Set<string> {
    const s = stateRef.current;
    if (!s.selected) return new Set();
    let nbr = new Set<string>([s.selected, ...s.downstream, ...s.upstream]);
    if (nbr.size > 150) {
      nbr = new Set<string>([s.selected]);
      for (const e of s.graph.edges) {
        if (e.from === s.selected) nbr.add(e.to);
        else if (e.to === s.selected) nbr.add(e.from);
      }
    }
    return nbr;
  }

  function cleanupSynthetic() {
    const cy = cyRef.current;
    if (!cy) return;
    for (const id of synthetic.current) cy.getElementById(id).remove();
    synthetic.current = [];
  }

  /** Show one side: members directly, or grouped by directory if there are many. */
  function buildSide(members: string[], side: "up" | "down", selectedId: string) {
    const cy = cyRef.current!;
    if (members.length <= GROUP_THRESHOLD) {
      for (const id of members) cy.getElementById(id).removeClass("hidden").addClass(side);
      return;
    }
    const byDir = new Map<string, string[]>();
    for (const id of members) {
      const d = dirOf(id);
      (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(id);
    }
    for (const [dir, ids] of byDir) {
      const key = `${side}:${dir}`;
      if (expanded.current.has(key)) {
        for (const id of ids) cy.getElementById(id).removeClass("hidden").addClass(side);
        continue;
      }
      const gid = `grp:${key}`;
      const last = dir.split("/").pop() || dir;
      cy.add({
        group: "nodes",
        data: { id: gid, label: `${last}/ (${ids.length})`, grp: true, key },
        classes: `grp ${side}`,
      });
      const eid = `grpe:${key}`;
      cy.add({
        group: "edges",
        data: {
          id: eid,
          source: side === "up" ? gid : selectedId,
          target: side === "up" ? selectedId : gid,
        },
        classes: "on",
      });
      synthetic.current.push(gid, eid);
    }
  }

  function applyView() {
    const cy = cyRef.current;
    if (!cy) return;
    cleanupSynthetic();
    if (cy.nodes().length === 0) return;
    const { selected, downstream, upstream, matched } = stateRef.current;

    cy.batch(() => {
      cy.elements().removeClass("sel down up match dim on hidden");

      if (selected) {
        const nbr = neighborhoodIds();
        cy.nodes().addClass("hidden");
        cy.edges().addClass("hidden");
        cy.getElementById(selected).removeClass("hidden").addClass("sel");

        const upMembers = [...upstream].filter((id) => nbr.has(id) && id !== selected);
        const downMembers = [...downstream].filter((id) => nbr.has(id) && id !== selected);
        buildSide(upMembers, "up", selected);
        buildSide(downMembers, "down", selected);

        cy.edges().forEach((e) => {
          if (e.id().startsWith("grpe")) return;
          if (!e.source().hasClass("hidden") && !e.target().hasClass("hidden")) {
            e.removeClass("hidden").addClass("on");
          }
        });
      } else if (matched) {
        cy.nodes().forEach((nd) => nd.addClass(matched.has(nd.id()) ? "match" : "dim"));
        cy.edges().addClass("dim");
      }
    });

    if (selected) {
      // Deterministic focus layout: selected centred, callers left, deps right.
      cy.getElementById(selected).position({ x: 0, y: 0 });
      placeSide(cy.nodes(".up:visible"), -1);
      placeSide(cy.nodes(".down:visible"), 1);
      cy.fit(cy.elements(":visible"), 60);
    } else {
      const pos = fullPos.current;
      if (pos.size) cy.nodes().positions((nd) => pos.get(nd.id()) ?? nd.position());
      cy.fit(undefined, 40);
    }
  }
  applyViewRef.current = applyView;

  const tooBig = graph.nodes.length > MAX_RENDER_NODES;

  return (
    <div className="graph-wrap">
      <div ref={containerRef} className="graph-canvas" />
      {tooBig && !selected && (
        <div className="graph-overlay">
          <p>This graph has {graph.nodes.length.toLocaleString()} nodes — too many to render smoothly.</p>
          <p className="muted">
            Scan a subdirectory, or pick a node from search to focus its neighbourhood.
          </p>
        </div>
      )}
    </div>
  );
}
