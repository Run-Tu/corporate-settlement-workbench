import assert from "node:assert/strict";
import { GRAPH_LAYOUTS, buildGraphEdges, buildGraphViews, findGraphNode } from "../src/features/graphModel.ts";

const steps = ["customer", "need", "scenario", "product", "process", "usage", "value"];
const labels = ["客户", "资金需求", "结算场景", "结算产品", "办理流程", "使用诊断", "价值结果"];
const analyses = steps.map((stepId) => {
  const entities = Array.from({ length: 8 }, (_, entityIndex) => ({
    badge: `${stepId}-badge-${entityIndex}`,
    detail: `${stepId}-detail-${entityIndex}`,
    details: [`${stepId}-field-${entityIndex}`],
    id: `${stepId}-entity-${entityIndex}`,
    label: `${stepId}-entity-${entityIndex}`,
    relation: `${stepId}-relation-${entityIndex}`,
    x: 12 + entityIndex * 10,
    y: 18 + (entityIndex % 4) * 18,
  }));
  const isSequence = GRAPH_LAYOUTS[stepId].linkMode === "sequence";
  return {
    entities,
    evidence: [`${stepId}-evidence`],
    metric: `${stepId}-metric`,
    relations: entities.map((entity, entityIndex) => ({
      detail: `${stepId}-edge-detail-${entityIndex}`,
      id: `${stepId}-edge-${entityIndex}`,
      label: `${stepId}-edge-label-${entityIndex}`,
      sourceId: isSequence && entityIndex ? entities[entityIndex - 1].id : `${stepId}-root`,
      targetId: entity.id,
      weight: 0.8,
    })),
    result: `${stepId}-result`,
    rootNodeId: `${stepId}-root`,
    stepId,
    title: `${stepId}-title`,
  };
});

const layoutCoordinates = new Set();

steps.forEach((stepId, activeStepIndex) => {
  const views = buildGraphViews(analyses, activeStepIndex, labels);
  const coreNodes = views.filter((node) => node.type === "core");
  const childNodes = views.filter((node) => node.type === "child");
  const edges = buildGraphEdges(views);
  const childEdges = edges.filter((edge) => edge.type === "child");
  const activeNode = coreNodes[coreNodes.length - 1];

  assert.equal(coreNodes.length, 1, `${stepId}: each step must render only its current concrete center node`);
  assert.equal(childNodes.length, 8, `${stepId}: the active step must expose a dense set of clickable entity nodes`);
  assert.equal(activeNode.id, `core-${stepId}`, `${stepId}: active node id must be stable`);
  assert.notEqual(activeNode.label, labels[activeStepIndex], `${stepId}: the center node must display its concrete business result`);
  assert.equal(findGraphNode(views, childNodes[0].id)?.detail, `${stepId}-detail-0`, `${stepId}: clicking an entity id must resolve detail-card content`);
  assert.equal(findGraphNode(views, "missing-node"), undefined, `${stepId}: unknown entity ids must not open a detail card`);
  assert.equal(childEdges[0].label, `${stepId}-edge-label-0`, `${stepId}: graph lines must expose relationship labels`);

  if (GRAPH_LAYOUTS[stepId].linkMode === "sequence") {
    assert.equal(childEdges[1].source.id, childNodes[0].id, `${stepId}: sequence layouts must connect adjacent entities`);
  } else {
    assert.equal(childEdges[1].source.id, activeNode.id, `${stepId}: radial layouts must connect entities to the active ontology node`);
  }

  layoutCoordinates.add(JSON.stringify(GRAPH_LAYOUTS[stepId].coordinates));
});

assert.equal(layoutCoordinates.size, steps.length, "each ontology step must have its own entity layout");
console.log("graph-model-ok: 7 current-step networks, relationship labels, dense entities, and detail-card lookup verified");
