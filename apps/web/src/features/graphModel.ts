import type { OntologyStep } from "../types";

export interface GraphEntity {
  badge: string;
  detail: string;
  details: string[];
  id: string;
  label: string;
  relation: string;
  x?: number;
  y?: number;
}

export interface GraphRelation {
  detail: string;
  id: string;
  label: string;
  sourceId: string;
  targetId: string;
  weight: number;
}

export interface GraphAnalysis {
  entities: GraphEntity[];
  evidence: string[];
  metric: string;
  relations?: GraphRelation[];
  result: string;
  rootNodeId?: string;
  stepId: OntologyStep["id"];
  title: string;
}

export interface GraphNodeView {
  analysis: GraphAnalysis;
  badge: string;
  detail: string;
  details: string[];
  id: string;
  index: number;
  label: string;
  parentIndex?: number;
  relation: string;
  tone: string;
  type: "core" | "child";
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  source: GraphNodeView;
  target: GraphNodeView;
  type: "core" | "child";
  label: string;
  detail: string;
  weight: number;
}

interface GraphLayout {
  coordinates: Array<[number, number]>;
  linkMode: "radial" | "sequence";
}

const COLORS = ["#0071e3", "#2563eb", "#7c3aed", "#f5a524", "#00a878", "#f43f8f", "#6bb700"];

export const GRAPH_LAYOUTS: Record<OntologyStep["id"], GraphLayout> = {
  customer: { coordinates: [[68, 20], [84, 38], [84, 68], [68, 84]], linkMode: "radial" },
  need: { coordinates: [[69, 18], [82, 36], [82, 64], [69, 82]], linkMode: "radial" },
  scenario: { coordinates: [[68, 18], [86, 35], [86, 67], [68, 84]], linkMode: "radial" },
  product: { coordinates: [[67, 20], [82, 39], [82, 68], [67, 84]], linkMode: "radial" },
  process: { coordinates: [[61, 22], [72, 38], [82, 56], [72, 77]], linkMode: "sequence" },
  usage: { coordinates: [[68, 20], [85, 37], [85, 68], [68, 84]], linkMode: "radial" },
  value: { coordinates: [[66, 20], [82, 38], [82, 66], [66, 84]], linkMode: "sequence" },
};

export function buildGraphViews(analyses: GraphAnalysis[], activeStepIndex: number, labels: string[]): GraphNodeView[] {
  const analysis = analyses[activeStepIndex];
  const active: GraphNodeView = {
    analysis,
    badge: labels[activeStepIndex],
    detail: analysis.result,
    details: [analysis.metric, analysis.title, ...analysis.evidence],
    id: `core-${analysis.stepId}`,
    index: activeStepIndex,
    label: shortLabel(analysis.result),
    relation: "当前环节核心实体",
    tone: COLORS[activeStepIndex],
    type: "core",
    x: 50,
    y: 52,
  };
  const layout = GRAPH_LAYOUTS[active.analysis.stepId];
  const childNodes: GraphNodeView[] = active.analysis.entities.map((entity, childIndex) => ({
    analysis: active.analysis,
    badge: entity.badge,
    detail: entity.detail,
    details: entity.details,
    id: `child-${active.analysis.stepId}-${entity.id}`,
    index: active.index,
    label: shortLabel(entity.label),
    parentIndex: active.index,
    relation: entity.relation,
    tone: active.tone,
    type: "child",
    x: entity.x ?? layout.coordinates[childIndex % layout.coordinates.length][0],
    y: entity.y ?? layout.coordinates[childIndex % layout.coordinates.length][1],
  }));
  return [active, ...childNodes];
}

export function buildGraphEdges(graphViews: GraphNodeView[]): GraphEdge[] {
  const coreNodes = graphViews.filter((node) => node.type === "core");
  const childNodes = graphViews.filter((node) => node.type === "child");
  const active = coreNodes[0];
  const linkMode = GRAPH_LAYOUTS[active.analysis.stepId].linkMode;
  return [
    ...(active.analysis.relations?.length
      ? active.analysis.relations.flatMap((relation) => {
          const source = relation.sourceId === active.analysis.rootNodeId ? active : childNodes.find((node) => node.id === `child-${active.analysis.stepId}-${relation.sourceId}`);
          const target = childNodes.find((node) => node.id === `child-${active.analysis.stepId}-${relation.targetId}`);
          return source && target
            ? [{ id: relation.id, source, target, type: "child" as const, label: relation.label, detail: relation.detail, weight: relation.weight }]
            : [];
        })
      : childNodes.map((node, index) => ({
          id: `child-${index}`,
          source: linkMode === "sequence" && index ? childNodes[index - 1] : active,
          target: node,
          type: "child" as const,
          label: node.relation,
          detail: node.relation,
          weight: 0.7,
        }))),
  ];
}

export function findGraphNode(graphViews: GraphNodeView[], nodeId: string): GraphNodeView | undefined {
  return graphViews.find((node) => node.id === nodeId);
}

function shortLabel(value: string): string {
  const compact = value.replace(/[：:]/g, " ").trim();
  return compact.length > 22 ? `${compact.slice(0, 22)}...` : compact;
}
