export interface Annotation {
  summary: string;
  writes: string[];
  reads: string[];
  config: string[];
  auth: string[];
  flows: string[];
}

export interface GraphNode {
  id: string;
  path: string;
  language: string;
  symbols: { name: string; kind: string }[];
  annotation?: Annotation;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface CallEdge {
  from: string;
  fromSymbol: string;
  to: string;
  toSymbol: string;
}

export interface CodeGraph {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  calls?: CallEdge[];
}

export type FlowKey = "writes" | "reads" | "auth";
export type ViewMode = "files" | "functions";
