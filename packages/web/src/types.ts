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

export type StopRole = "entrypoint" | "hub" | "foundation" | "leaf" | "core";

export interface CurriculumStop {
  id: string;
  order: number;
  role: StopRole;
  dependedOnBy: number;
  dependsOn: number;
  seenDeps: string[];
  newDeps: string[];
  cluster: string[];
  symbols: string[];
  summary?: string;
  why: string;
}

export interface CurriculumChapter {
  title: string;
  kind: "spine" | "module";
  blurb: string;
  stops: CurriculumStop[];
}

export type ReadingOrder = "foundations" | "entrypoints";

export interface Curriculum {
  root: string;
  order: ReadingOrder;
  chapters: CurriculumChapter[];
  totalStops: number;
  totalFiles: number;
  excluded: { tests: number; generated: number; trivial: number; total: number };
  cycles: number;
}
