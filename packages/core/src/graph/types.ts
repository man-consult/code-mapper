export type Language = "typescript" | "javascript" | "python";

export type EdgeKind = "import";

export interface SymbolInfo {
  name: string;
  /** Declaration kind, e.g. "FunctionDeclaration", "ClassDeclaration", "def", "class". */
  kind: string;
}

/**
 * Semantic layer produced by the LLM annotation pass (phase 3).
 * Topology (dependencies) is never inferred here — only meaning.
 */
export interface Annotation {
  /** One- or two-sentence plain-English summary of the file's role. */
  summary: string;
  /** Data stores this code WRITES to (tables/collections/caches/queues). */
  writes: string[];
  /** Data stores this code READS from. */
  reads: string[];
  /** Environment variables / config / secrets this code reads. */
  config: string[];
  /** Auth / authorization gates this code enforces or relies on. */
  auth: string[];
  /** Notable data-flow steps, as short phrases. */
  flows: string[];
}

export interface GraphNode {
  /** Stable id = POSIX path relative to the scan root (e.g. "src/api/users.ts"). */
  id: string;
  path: string;
  language: Language;
  symbols: SymbolInfo[];
  /** Present only after the annotation pass has run. */
  annotation?: Annotation;
}

export interface GraphEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  kind: EdgeKind;
}

/**
 * Function-level call edge: a symbol in one file invokes a symbol in another.
 * Only emitted for calls whose target resolves to a file inside the scan set.
 */
export interface CallEdge {
  /** File id of the call site. */
  from: string;
  /** Enclosing function/method/variable name at the call site ("<module>" if top-level). */
  fromSymbol: string;
  /** File id where the callee is declared. */
  to: string;
  /** Name of the callee symbol. */
  toSymbol: string;
}

export interface CodeGraph {
  /** Absolute scan root. */
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Function-level call edges (TS/JS only for now). */
  calls: CallEdge[];
}
