import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent, WheelEvent } from "react";
import luluSpritesheet from "./assets/xin-companion/lulu-spritesheet.webp";
import { loadSettlementData } from "./data/settlementDataApi";
import { AsrAnalyzerDialog } from "./features/AsrAnalyzerDialog";
import { analyzeBranch, analyzeCustomer, ontologySteps } from "./features/analysis";
import { buildGraphEdges, buildGraphViews, findGraphNode } from "./features/graphModel";
import type { GraphAnalysis, GraphEntity, GraphRelation } from "./features/graphModel";
import { ASSISTANT_PROMPT_KEYS, answerQuestion, buildBattleCard, buildNodeInsight, buildReportSummary, isFixedStageQuestion, selectPromptKey } from "./services/businessAssistant";
import type { AsrTranscriptionResult } from "./services/asr";
import { askProjectAssistant } from "./services/projectAssistant";
import { analyzeStatement, answerStatementQuestion } from "./services/statementAnalyzer";
import type { StatementAnalysisResult } from "./services/statementAnalyzer";
import type { AssistantMessage, BranchAnalysis, Customer, CustomerAnalysis, OntologyStep, SettlementDataset } from "./types";

type WorkbenchTab = "evidence" | "plan" | "battle" | "value";
type StatementResultTab = "recognition" | "extraction" | "analysis";
type CustomerComputationSource = "branch" | "search";

interface CustomerComputationState {
  customerId: string;
  source: CustomerComputationSource;
  runId: number;
  phaseDurations: [number, number, number];
}

type NodeAnalysis = GraphAnalysis;

const STEP_HINTS: Record<OntologyStep["id"], string> = {
  customer: "确认客户主体、责任归属、账户范围和数据完备性。",
  need: "识别客户当前资金状态，并查看支撑该判断的流水证据。",
  scenario: "把资金需求翻译成客户经理可沟通的经营结算场景。",
  product: "按场景匹配组合产品，区分存量覆盖和缺口机会。",
  process: "生成办理问题、材料清单和沟通动作。",
  usage: "诊断客户签约、激活和产品使用深度。",
  value: "估算存款沉淀、结算交易和支行盘户价值。",
};

export default function App() {
  const [dataset, setDataset] = useState<SettlementDataset | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("evidence");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [customerMessages, setCustomerMessages] = useState<Record<string, AssistantMessage[]>>({});
  const [dataError, setDataError] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const [statementToolOpen, setStatementToolOpen] = useState(false);
  const [asrToolOpen, setAsrToolOpen] = useState(false);
  const [statementResults, setStatementResults] = useState<Record<string, StatementAnalysisResult>>({});
  const [asrResults, setAsrResults] = useState<Record<string, AsrTranscriptionResult>>({});
  const [viewMode, setViewMode] = useState<"story" | "workbench">("story");
  const [customerComputation, setCustomerComputation] = useState<CustomerComputationState | null>(null);
  const [companionThinking, setCompanionThinking] = useState(false);
  const [stageAnimation, setStageAnimation] = useState<"" | "leave-left" | "leave-right" | "enter-left" | "enter-right">("");
  const [stageDragOffset, setStageDragOffset] = useState(0);
  const stageTransitionTimersRef = useRef<number[]>([]);
  const stageDragRef = useRef<{ pointerId: number; startX: number } | null>(null);
  const stageWheelLockRef = useRef(0);
  const customerComputationTimerRef = useRef<number | null>(null);
  const customerComputationCallbackRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    loadSettlementData()
      .then((loadedDataset) => {
        setDataset(loadedDataset);
        setSelectedCustomerId(loadedDataset.customers[0]?.customerId ?? "");
        setTimeout(() => setLoaded(true), 100);
      })
      .catch((error: unknown) => {
        setDataError(error instanceof Error ? error.message : "未知数据加载错误");
      });
  }, []);

  const customer = useMemo(() => {
    if (!dataset) return null;
    return dataset.customers.find((item) => item.customerId === selectedCustomerId) ?? dataset.customers[0] ?? null;
  }, [dataset, selectedCustomerId]);

  const analysis = useMemo(() => {
    if (!dataset || !customer) return null;
    return analyzeCustomer(customer, dataset);
  }, [customer, dataset]);

  const branch = useMemo(() => {
    if (!dataset) return null;
    return analyzeBranch(dataset.customers, dataset);
  }, [dataset]);

  const computationAnalysis = useMemo(() => {
    if (!dataset || !customerComputation) return null;
    const targetCustomer = dataset.customers.find((item) => item.customerId === customerComputation.customerId);
    return targetCustomer ? analyzeCustomer(targetCustomer, dataset) : null;
  }, [customerComputation, dataset]);

  useEffect(() => () => {
    stageTransitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    if (customerComputationTimerRef.current) window.clearTimeout(customerComputationTimerRef.current);
  }, []);

  useEffect(() => {
    if (viewMode !== "workbench") return undefined;
    function handleStageKeys(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") moveToStage(activeStepIndex - 1);
      if (event.key === "ArrowRight") moveToStage(activeStepIndex + 1);
    }
    window.addEventListener("keydown", handleStageKeys);
    return () => window.removeEventListener("keydown", handleStageKeys);
  }, [activeStepIndex, stageAnimation, viewMode]);

  if (!dataset || !customer || !analysis || !branch) {
    return dataError ? <DataError message={dataError} /> : <Loading />;
  }

  const activeStep = ontologySteps[activeStepIndex];
  const nodeAnalyses = buildNodeAnalyses(analysis, branch, dataset);

  function moveToStage(requestedIndex: number) {
    const targetIndex = clamp(requestedIndex, 0, ontologySteps.length - 1);
    if (targetIndex === activeStepIndex || stageAnimation) return;
    const forward = targetIndex > activeStepIndex;
    stageTransitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    stageTransitionTimersRef.current = [];
    setStageDragOffset(0);
    setStageAnimation(forward ? "leave-left" : "leave-right");

    const swapTimer = window.setTimeout(() => {
      setActiveStepIndex(targetIndex);
      setActiveTab(tabForStep(ontologySteps[targetIndex].id));
      setStageAnimation(forward ? "enter-right" : "enter-left");
      const settleTimer = window.setTimeout(() => setStageAnimation(""), 380);
      stageTransitionTimersRef.current.push(settleTimer);
    }, 150);
    stageTransitionTimersRef.current.push(swapTimer);
  }

  function handleStageWheel(event: WheelEvent<HTMLElement>) {
    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey
        ? event.deltaY
        : 0;
    if (Math.abs(horizontalDelta) < 24) return;
    event.preventDefault();
    const now = Date.now();
    if (now - stageWheelLockRef.current < 650) return;
    stageWheelLockRef.current = now;
    moveToStage(activeStepIndex + (horizontalDelta > 0 ? 1 : -1));
  }

  function handleStagePointerDown(event: PointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [role='dialog']")) return;
    stageDragRef.current = { pointerId: event.pointerId, startX: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleStagePointerMove(event: PointerEvent<HTMLElement>) {
    const drag = stageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setStageDragOffset(clamp(event.clientX - drag.startX, -150, 150));
  }

  function handleStagePointerEnd(event: PointerEvent<HTMLElement>) {
    const drag = stageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offset = event.clientX - drag.startX;
    stageDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setStageDragOffset(0);
    if (Math.abs(offset) >= 72) moveToStage(activeStepIndex + (offset < 0 ? 1 : -1));
  }

  function finishCustomerComputation(customerId: string) {
    if (customerComputationTimerRef.current) {
      window.clearTimeout(customerComputationTimerRef.current);
      customerComputationTimerRef.current = null;
    }
    if (customerId !== selectedCustomerId) {
      setSelectedCustomerId(customerId);
      setMessages(customerMessages[customerId] ?? []);
    }
    setActiveStepIndex(0);
    setActiveTab("evidence");
    setTransitioning(false);
    setCustomerComputation(null);
    const callback = customerComputationCallbackRef.current;
    customerComputationCallbackRef.current = undefined;
    callback?.();
  }

  function selectCustomer(
    customerId: string,
    onSelected?: () => void,
    source: CustomerComputationSource = "search",
  ) {
    if (customerComputation) return;
    const phaseDurations = createComputationDurations();
    setCustomerMessages((prev) => ({ ...prev, [selectedCustomerId]: messages }));
    customerComputationCallbackRef.current = onSelected;
    setCustomerComputation({ customerId, source, runId: Date.now(), phaseDurations });
    customerComputationTimerRef.current = window.setTimeout(
      () => finishCustomerComputation(customerId),
      phaseDurations.reduce((total, duration) => total + duration, 0),
    );
  }

  function askAi(question: string) {
    if (!analysis) return;
    const text = question.trim();
    if (!text) return;
    const fixedStageQuestion = isFixedStageQuestion(text, activeStep.id);
    const promptKey = fixedStageQuestion ? selectPromptKey(text) : ASSISTANT_PROMPT_KEYS.OPEN_CUSTOMER_QA;
    setCompanionThinking(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "user", text, promptKey },
      { role: "assistant", text: "" },
    ]);

    void (async () => {
      let answer;
      if (fixedStageQuestion) {
        answer = answerQuestion(text, analysis, activeStep.id);
      } else {
        try {
          answer = await askProjectAssistant(
            text,
            analysis,
            activeStep.id,
            promptKey,
            asrResults[analysis.customer.customerId]?.insight,
          );
        } catch {
          const fallback = answerQuestion(text, analysis, activeStep.id);
          answer = { ...fallback, sources: ["GLM-5.2 暂不可用，已切换本地规则", ...fallback.sources] };
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      const fullText = answer.text;
      let charIndex = 0;
      const interval = setInterval(() => {
        charIndex += 2;
        if (charIndex >= fullText.length) {
          clearInterval(interval);
          setCompanionThinking(false);
          setMessages((currentMessages) => {
            const updated = [...currentMessages];
            updated[updated.length - 1] = {
              role: "assistant",
              text: fullText,
              confidence: answer.confidence,
              sources: answer.sources,
            };
            return updated;
          });
          return;
        }
        setMessages((currentMessages) => {
          const updated = [...currentMessages];
          updated[updated.length - 1] = { role: "assistant", text: fullText.slice(0, charIndex) };
          return updated;
        });
      }, 16);
    })();
  }

  return (
    <main className={`app-shell ${loaded ? "is-loaded" : ""} view-${viewMode}`}>
      <TopBar
        customers={dataset.customers}
        selectedCustomerId={analysis.customer.customerId}
        onSelectCustomer={selectCustomer}
        viewMode={viewMode}
        onSelectView={setViewMode}
      />
      {viewMode === "story" ? (
        <CinematicJourney
          analysis={analysis}
          branch={branch}
          dataset={dataset}
          onOpenWorkbench={(stepIndex, tab) => {
            setActiveStepIndex(stepIndex);
            setActiveTab(tab);
            setViewMode("workbench");
          }}
          onSelectCustomer={(customerId, onSelected) => selectCustomer(customerId, onSelected, "branch")}
        />
      ) : (
        <section className={`workbench stage-workbench ${transitioning ? "is-transitioning" : ""}`}>
          <WorkflowMap activeStep={activeStep} activeStepIndex={activeStepIndex} analysis={analysis} onSelectStep={moveToStage} />
          <section
            className={`stage-carousel ${stageDragRef.current ? "is-dragging" : ""}`}
            aria-label="七环节横向工作台"
            onWheel={handleStageWheel}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerEnd}
            onPointerCancel={handleStagePointerEnd}
          >
            <div className="stage-edge-zone is-left">
              <button
                type="button"
                className="stage-edge-button"
                aria-label="切换到上一环节"
                disabled={activeStepIndex === 0 || Boolean(stageAnimation)}
                onClick={() => moveToStage(activeStepIndex - 1)}
              >
                <span>←</span><em>上一环</em>
              </button>
            </div>
            <div className="stage-edge-zone is-right">
              <button
                type="button"
                className="stage-edge-button"
                aria-label="切换到下一环节"
                disabled={activeStepIndex === ontologySteps.length - 1 || Boolean(stageAnimation)}
                onClick={() => moveToStage(activeStepIndex + 1)}
              >
                <em>下一环</em><span>→</span>
              </button>
            </div>
            <div className="stage-drag-frame" style={{ "--stage-drag-x": `${stageDragOffset}px` } as CSSProperties}>
              <section className={`stage-page stage-page-${activeStep.id} ${stageAnimation}`} key={activeStep.id}>
                <div className="stage-page-heading">
                  <span>环节 {String(activeStepIndex + 1).padStart(2, "0")} / {String(ontologySteps.length).padStart(2, "0")}</span>
                  <div>
                    <h2>{activeStep.label}</h2>
                    <p>{STEP_HINTS[activeStep.id]}</p>
                  </div>
                  <strong>{analysis.customer.customerName}</strong>
                </div>
                <div className="stage-page-grid">
                  <aside className="stage-context-column">
                    <CustomerPanel analysis={analysis} branch={branch} activeStep={activeStep} />
                  </aside>
                  <section className="stage-business-content">
                    <InsightGrid
                      activeStep={activeStep}
                      nodeAnalyses={nodeAnalyses}
                      analysis={analysis}
                      statementResult={statementResults[analysis.customer.customerId]}
                      asrResult={asrResults[analysis.customer.customerId]}
                      onOpenAsrTool={() => setAsrToolOpen(true)}
                      onOpenStatementTool={() => setStatementToolOpen(true)}
                    />
                    <WorkbenchBody
                      activeTab={activeTab}
                      activeStep={activeStep}
                      analysis={analysis}
                      branch={branch}
                      dataset={dataset}
                      statementResult={statementResults[analysis.customer.customerId]}
                      asrResult={asrResults[analysis.customer.customerId]}
                      onAskAssistant={askAi}
                    />
                  </section>
                </div>
              </section>
            </div>
          </section>
        </section>
      )}
      <BusinessCompanion
        analysis={analysis}
        activeStep={activeStep}
        messages={messages}
        isOpen={assistantExpanded}
        isAnalyzing={Boolean(customerComputation) || companionThinking}
        onToggle={() => setAssistantExpanded((current) => !current)}
        onClose={() => setAssistantExpanded(false)}
        onAskAssistant={askAi}
        onReset={() => setMessages([])}
      />
      {statementToolOpen && (
        <StatementAnalyzerDialog
          analysis={analysis}
          initialResult={statementResults[analysis.customer.customerId]}
          onAnalysisComplete={(result) => setStatementResults((current) => ({ ...current, [analysis.customer.customerId]: result }))}
          onClose={() => setStatementToolOpen(false)}
        />
      )}
      {asrToolOpen && (
        <AsrAnalyzerDialog
          customerName={analysis.customer.customerName}
          initialResult={asrResults[analysis.customer.customerId]}
          onAnalysisComplete={(result) => setAsrResults((current) => ({ ...current, [analysis.customer.customerId]: result }))}
          onClose={() => setAsrToolOpen(false)}
        />
      )}
      {customerComputation && computationAnalysis && (
        <CustomerComputationOverlay
          key={customerComputation.runId}
          analysis={computationAnalysis}
          dataset={dataset}
          source={customerComputation.source}
          phaseDurations={customerComputation.phaseDurations}
          onSkip={() => finishCustomerComputation(customerComputation.customerId)}
        />
      )}
    </main>
  );
}

function CustomerComputationOverlay({
  analysis,
  dataset,
  source,
  phaseDurations,
  onSkip,
}: {
  analysis: CustomerAnalysis;
  dataset: SettlementDataset;
  source: CustomerComputationSource;
  phaseDurations: [number, number, number];
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState(0);
  const customerRelations = dataset.customerRelations.filter((item) => item.customerId === analysis.customer.customerId);
  const candidateProducts = unique(analysis.bundles.slice(0, 2).flatMap((bundle) => bundle.products));
  const topNeed = analysis.needs[0];
  const topScenario = analysis.scenarios[0];
  const scenarioTriggerNeed = analysis.needs.find((item) => item.needId === topScenario?.triggerNeedId) ?? topNeed;
  const confidence = Math.round((((topNeed?.confidence ?? 0.82) + (topScenario?.confidence ?? 0.82)) / 2) * 100);
  const phaseLabels = ["聚合业务数据", "推演结算场景", "生成经营结论"];
  const sourceNodes = [
    { label: "客户档案", value: "主体已确认", icon: "企", x: "10%", y: "15%" },
    { label: "账户台账", value: `${analysis.accounts.length} 个账户`, icon: "账", x: "69%", y: "11%" },
    { label: "近90日流水", value: `${analysis.transactions.length} 笔交易`, icon: "流", x: "69%", y: "63%" },
    { label: "产品使用", value: `${analysis.usages.length} 项记录`, icon: "产", x: "11%", y: "68%" },
    { label: "经营关系", value: `${customerRelations.length} 条关系`, icon: "联", x: "39%", y: "81%" },
  ];

  useEffect(() => {
    const reasoningTimer = window.setTimeout(() => setPhase(1), phaseDurations[0]);
    const conclusionTimer = window.setTimeout(() => setPhase(2), phaseDurations[0] + phaseDurations[1]);
    return () => {
      window.clearTimeout(reasoningTimer);
      window.clearTimeout(conclusionTimer);
    };
  }, [phaseDurations]);

  return (
    <section className={`customer-computation-overlay calculation-phase-${phase}`} role="dialog" aria-label="客户洞察计算过程" aria-live="polite">
      <div className="calculation-backdrop-grid" aria-hidden="true" />
      <header className="calculation-header">
        <div>
          <span>客户经营智能推演</span>
          <strong>{source === "branch" ? "正在从支行经营图谱下钻客户" : "正在建立客户经营画像"}</strong>
        </div>
        <div className="calculation-header-status"><i />{phaseLabels[phase]}</div>
        <button type="button" onClick={onSkip}>跳过动画</button>
      </header>

      <div className="calculation-progress" aria-label={`当前阶段：${phaseLabels[phase]}`}>
        {phaseLabels.map((label, index) => (
          <div className={index < phase ? "is-done" : index === phase ? "is-active" : ""} key={label}>
            <span>{index < phase ? "✓" : `0${index + 1}`}</span>
            <strong>{label}</strong>
          </div>
        ))}
      </div>

      <div className="calculation-workspace">
        <section className="calculation-visual" aria-label="数据汇聚与业务推演动画">
          <div className="calculation-orbit orbit-a" /><div className="calculation-orbit orbit-b" /><div className="calculation-scan-line" />
          <svg className="calculation-links" viewBox="0 0 720 520" preserveAspectRatio="none" aria-hidden="true">
            <line x1="360" y1="255" x2="112" y2="105" /><line x1="360" y1="255" x2="590" y2="86" />
            <line x1="360" y1="255" x2="630" y2="365" /><line x1="360" y1="255" x2="115" y2="385" />
            <line x1="360" y1="255" x2="360" y2="455" />
          </svg>
          {sourceNodes.map((node, index) => (
            <article className="calculation-source-node" key={node.label} style={{ left: node.x, top: node.y, "--source-delay": `${index * 110}ms` } as CSSProperties}>
              <i>{node.icon}</i><div><strong>{node.label}</strong><span>{node.value}</span></div><em>接入</em>
            </article>
          ))}
          <div className="calculation-core">
            <div className="calculation-core-rings"><i /><i /><i /></div>
            <span>{source === "branch" ? "图谱定位" : "主体匹配"}</span>
            <strong>{analysis.customer.customerName}</strong>
            <em>{analysis.customer.industry} · {analysis.customer.managerName}</em>
          </div>
          <div className="calculation-engine-label"><i />规则引擎与本体模型正在联合推演</div>
        </section>

        <section className="calculation-result-stack">
          <div className="calculation-data-trace" aria-hidden={phase !== 0}>
            <span>数据汇聚</span><h2>数据证据正在汇聚</h2>
            <p>系统正在关联客户主体、账户余额、交易流水和产品使用记录。</p>
            <dl>
              <div><dt>当前余额</dt><dd>{money(analysis.features.currentBalance)}</dd></div>
              <div><dt>近90日均额</dt><dd>{money(analysis.features.avgBalance90d)}</dd></div>
              <div><dt>交易样本</dt><dd>{analysis.transactions.length} 笔</dd></div>
            </dl>
          </div>

          <div className="calculation-reasoning" aria-hidden={phase !== 1}>
            <span>分层推理</span><h2>从资金问题推演经营场景</h2>
            <div className="calculation-chain">
              <div><i>01</i><strong>资金需求</strong><em>{scenarioTriggerNeed?.needType ?? "资金状态识别"}</em></div>
              <b>→</b>
              <div><i>02</i><strong>结算场景</strong><em>{topScenario?.scenarioName ?? "经营场景识别"}</em></div>
              <b>→</b>
              <div><i>03</i><strong>产品匹配</strong><em>{candidateProducts.length} 项组合产品</em></div>
            </div>
            <ul>
              <li><i />余额与收支特征已完成校验</li>
              <li><i />关键流水证据已关联场景规则</li>
              <li><i />产品覆盖与缺口正在交叉验证</li>
            </ul>
          </div>

          <div className="calculation-conclusion" aria-hidden={phase !== 2}>
            <span>结论生成</span><h2>客户经营结论已形成</h2>
            <div className="calculation-conclusion-card">
              <div><small>识别需求</small><strong>{analysis.needs.slice(0, 2).map((item) => item.needType).join("、")}</strong></div>
              <div><small>核心场景</small><strong>{analysis.scenarios.slice(0, 2).map((item) => item.scenarioName).join("、")}</strong></div>
              <div><small>推荐组合</small><strong>{candidateProducts.slice(0, 3).map((item) => item.productName).join(" + ")}</strong></div>
            </div>
            <footer><span>综合置信度 <strong>{confidence}%</strong></span><span>预计资金沉淀 <strong>{money(analysis.value.estimatedDepositIncrease)}</strong></span></footer>
          </div>
        </section>
      </div>

      <footer className="calculation-footer">
        <span><i />分析口径：近90日账户、流水与产品使用数据</span>
        <strong>{phase === 2 ? "结论已生成，即将进入客户工作台" : `${phaseLabels[phase]}中…`}</strong>
      </footer>
    </section>
  );
}

function CinematicJourney({
  analysis,
  branch,
  dataset,
  onOpenWorkbench,
  onSelectCustomer,
}: {
  analysis: CustomerAnalysis;
  branch: BranchAnalysis;
  dataset: SettlementDataset;
  onOpenWorkbench: (stepIndex: number, tab: WorkbenchTab) => void;
  onSelectCustomer: (customerId: string, onSelected?: () => void) => void;
}) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedTxnId, setSelectedTxnId] = useState("");
  const [isPanning, setIsPanning] = useState(false);
  const [manualCamera, setManualCamera] = useState<{ scale: number; x: number; y: number } | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const cameraDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const nodeDragRef = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const draggedNodeRef = useRef("");
  const worldCenter = { x: 900, y: 490 };
  const customerPositions = [
    { x: 245, y: 650 }, { x: 465, y: 130 }, { x: 735, y: 115 }, { x: 1080, y: 130 },
    { x: 1375, y: 235 }, { x: 1300, y: 455 }, { x: 1250, y: 640 }, { x: 1115, y: 760 },
    { x: 835, y: 780 }, { x: 500, y: 740 }, { x: 250, y: 680 }, { x: 145, y: 445 },
  ];
  const plottedTransactions = useMemo(() => analysis.transactions.slice(-12).map((txn, index, rows) => {
    const angle = (index / Math.max(rows.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = 265 + (index % 2) * 125;
    return {
      txn,
      x: 820 + Math.cos(angle) * radius,
      y: 485 + Math.sin(angle) * radius * 0.75,
    };
  }), [analysis.transactions]);
  const selectedPlot = plottedTransactions.find((item) => item.txn.txnId === selectedTxnId);
  const selectedTxn = selectedPlot?.txn;
  const topScenario = analysis.scenarios[0];
  const similarCustomerIds = new Set(branch.opportunities.filter((item) => item.topScenario === topScenario.scenarioName).map((item) => item.customerId));
  const branchNodes = dataset.customers.map((customer, index) => {
    const opportunity = branch.opportunities.find((item) => item.customerId === customer.customerId);
    return { customer, opportunity, position: customerPositions[index % customerPositions.length] };
  });
  const actionProducts = unique(analysis.bundles.slice(0, 2).flatMap((bundle) => bundle.products));
  const scenes = [
    {
      level: "支行全景",
      kicker: "从组织全貌发现优先客户",
      title: `${dataset.branch.branchName}结算经营图谱`,
      summary: `${branch.customerCount} 户企业被组织成可下探的经营网络，${analysis.customer.customerName}是当前重点机会。`,
      metric: `${branch.opportunityCount} 户机会客户`,
    },
    {
      level: selectedTxn ? "原始证据" : "客户证据",
      kicker: "从数据到理解",
      title: selectedTxn ? `${selectedTxn.counterpartyName} · ${money(selectedTxn.amount)}` : `${analysis.customer.customerName}资金需求`,
      summary: selectedTxn
        ? `${selectedTxn.txnDate}，${selectedTxn.channel}，摘要“${selectedTxn.summary}”。该笔流水用于支撑资金需求判断，暂不在本层判定结算场景。`
        : `${analysis.transactions.length} 笔流水、${analysis.accounts.length} 个账户和余额变化共同解释客户当前需要解决的资金问题；本层只识别需求，不判断场景。点击任一流水可继续下探。`,
      metric: `${analysis.needs.length} 项资金需求`,
    },
    {
      level: "场景行动",
      kicker: "从理解到行动",
      title: `${analysis.scenarios.slice(0, 2).map((item) => item.scenarioName.replace("场景", "")).join(" × ")}`,
      summary: `承接上一层已确认的资金需求，系统判断需求发生在哪类经营活动中，再连接产品组合、覆盖缺口和办理动作。`,
      metric: `${actionProducts.length} 项组合产品`,
    },
    {
      level: "组织能力",
      kicker: "从单户到支行",
      title: `一户方法，复制到${similarCustomerIds.size}户相似客户`,
      summary: `视角回到支行全景，相同场景客户被重新点亮，形成客户清单、产品缺口和经营任务。`,
      metric: `预计沉淀 ${money(branch.totalDepositIncrease)}`,
    },
  ];

  const sceneCamera = selectedPlot
    ? { scale: 2.15, x: (worldCenter.x - selectedPlot.x) * 2.15, y: (worldCenter.y - selectedPlot.y) * 2.15 }
    : [
      { scale: 0.74, x: 70, y: 12 },
      { scale: 0.82, x: 100, y: 10 },
      { scale: 1.08, x: -190, y: -18 },
      { scale: 0.68, x: 55, y: 8 },
    ][sceneIndex];
  const activeCamera = manualCamera ?? sceneCamera;
  const cameraStyle = {
    "--camera-scale": activeCamera.scale,
    "--camera-x": `${activeCamera.x}px`,
    "--camera-y": `${activeCamera.y}px`,
  } as CSSProperties;

  function goToScene(index: number) {
    setSelectedTxnId("");
    setManualCamera(null);
    setSceneIndex((index + scenes.length) % scenes.length);
  }

  function nodeStyle(id: string, x: number, y: number, depth = 0, extra: CSSProperties = {}) {
    const offset = nodeOffsets[id] ?? { x: 0, y: 0 };
    return {
      left: x + offset.x,
      top: y + offset.y,
      "--node-depth": `${depth}px`,
      ...extra,
    } as CSSProperties;
  }

  function nodePoint(id: string, x: number, y: number) {
    const offset = nodeOffsets[id] ?? { x: 0, y: 0 };
    return { x: x + offset.x, y: y + offset.y };
  }

  function beginNodeDrag(event: PointerEvent<HTMLElement>, id: string) {
    event.stopPropagation();
    const offset = nodeOffsets[id] ?? { x: 0, y: 0 };
    nodeDragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleJourneyPointerDown(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (selectedTxnId && !target.closest(".journey-txn-node.is-selected")) {
      setSelectedTxnId("");
      setManualCamera(null);
      setIsPanning(false);
      return;
    }
    if (target.closest(".journey-draggable-node, button, article")) return;
    const currentCamera = manualCamera ?? sceneCamera;
    cameraDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: currentCamera.x,
      originY: currentCamera.y,
    };
    setManualCamera(currentCamera);
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleJourneyPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (nodeDragRef.current) {
      const drag = nodeDragRef.current;
      const deltaX = (event.clientX - drag.startX) / Math.max(activeCamera.scale, 0.45);
      const deltaY = (event.clientY - drag.startY) / Math.max(activeCamera.scale, 0.45);
      if (Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true;
      setNodeOffsets((current) => ({
        ...current,
        [drag.id]: { x: drag.originX + deltaX, y: drag.originY + deltaY },
      }));
      return;
    }
    if (!cameraDragRef.current) return;
    const drag = cameraDragRef.current;
    setManualCamera((current) => ({
      scale: current?.scale ?? activeCamera.scale,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  }

  function handleJourneyPointerEnd() {
    if (nodeDragRef.current?.moved) {
      const draggedId = nodeDragRef.current.id;
      draggedNodeRef.current = draggedId;
      window.setTimeout(() => {
        if (draggedNodeRef.current === draggedId) draggedNodeRef.current = "";
      }, 0);
    }
    nodeDragRef.current = null;
    cameraDragRef.current = null;
    setIsPanning(false);
  }

  function ignoreClickAfterDrag(id: string) {
    if (draggedNodeRef.current !== id) return false;
    draggedNodeRef.current = "";
    return true;
  }

  function handleJourneyWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const current = manualCamera ?? sceneCamera;
    const nextScale = Math.min(2.4, Math.max(0.45, current.scale * (event.deltaY < 0 ? 1.1 : 0.9)));
    setManualCamera({ ...current, scale: nextScale });
  }

  function zoomJourney(factor: number) {
    const current = manualCamera ?? sceneCamera;
    setManualCamera({ ...current, scale: Math.min(2.4, Math.max(0.45, current.scale * factor)) });
  }

  function resetJourneyView() {
    setSelectedTxnId("");
    setManualCamera(null);
    setNodeOffsets({});
    setIsPanning(false);
  }

  const coreBasePosition = sceneIndex === 2 ? { x: 900, y: 485 } : { x: 820, y: 485 };

  useEffect(() => {
    if (!isPlaying || selectedTxnId) return undefined;
    const timer = window.setTimeout(() => goToScene(sceneIndex + 1), 6200);
    return () => window.clearTimeout(timer);
  }, [isPlaying, sceneIndex, selectedTxnId]);

  useEffect(() => {
    function navigateByKeyboard(event: KeyboardEvent) {
      if (event.key === "ArrowRight") goToScene(sceneIndex + 1);
      if (event.key === "ArrowLeft") goToScene(sceneIndex - 1);
      if (event.key === "Escape" && selectedTxnId) setSelectedTxnId("");
    }
    window.addEventListener("keydown", navigateByKeyboard);
    return () => window.removeEventListener("keydown", navigateByKeyboard);
  }, [sceneIndex, selectedTxnId]);

  return (
    <section className={`cinematic-journey scene-${sceneIndex} ${selectedTxn ? "is-micro-focused" : ""}`} aria-label="结算经营全景推演">
      <header className="journey-header">
        <div><span>本体关联图谱</span><strong>结算经营全景推演</strong></div>
        <div className="journey-header-actions">
          <span className="journey-camera-level"><i />{scenes[sceneIndex].level}</span>
          <div className="journey-zoom-controls" aria-label="图谱缩放控制">
            <button type="button" aria-label="缩小图谱" onClick={() => zoomJourney(0.88)}>−</button>
            <span>{Math.round(activeCamera.scale * 100)}%</span>
            <button type="button" aria-label="放大图谱" onClick={() => zoomJourney(1.12)}>＋</button>
            <button type="button" onClick={resetJourneyView}>复位</button>
          </div>
          <button onClick={() => setIsPlaying((current) => !current)}>{isPlaying ? "暂停推演" : "自动推演"}</button>
          <button className="journey-workbench-button" onClick={() => onOpenWorkbench(sceneIndex === 1 ? 2 : sceneIndex === 2 ? 4 : sceneIndex === 3 ? 6 : 0, sceneIndex === 1 ? "evidence" : sceneIndex === 2 ? "battle" : sceneIndex === 3 ? "value" : "evidence")}>进入详细工作台</button>
        </div>
      </header>

      <div className="journey-stage">
        <div className="journey-grid" aria-hidden="true" />
        <article className="journey-scene-copy" key={`${sceneIndex}-${selectedTxnId}`}>
          <span>{scenes[sceneIndex].kicker}</span>
          <h1>{scenes[sceneIndex].title}</h1>
          <p>{scenes[sceneIndex].summary}</p>
          <strong>{scenes[sceneIndex].metric}</strong>
          {selectedTxn && <button onClick={() => setSelectedTxnId("")}>← 返回客户证据层</button>}
        </article>

        <div
          className={`journey-viewport ${isPanning ? "is-panning" : ""}`}
          onWheel={handleJourneyWheel}
          onPointerDown={handleJourneyPointerDown}
          onPointerMove={handleJourneyPointerMove}
          onPointerUp={handleJourneyPointerEnd}
          onPointerCancel={handleJourneyPointerEnd}
        >
          <div className="journey-camera-world" style={cameraStyle}>
            <svg className="journey-world-links" viewBox="0 0 1800 980" aria-hidden="true">
              <g className="branch-link-group">
                {branchNodes.map((item) => {
                  const core = nodePoint("journey-core", coreBasePosition.x, coreBasePosition.y);
                  const target = nodePoint(`customer-${item.customer.customerId}`, item.position.x, item.position.y);
                  return <line key={item.customer.customerId} x1={core.x} y1={core.y} x2={target.x} y2={target.y} />;
                })}
              </g>
              <g className="evidence-link-group">
                {plottedTransactions.map((item) => {
                  const core = nodePoint("journey-core", coreBasePosition.x, coreBasePosition.y);
                  const target = nodePoint(`txn-${item.txn.txnId}`, item.x, item.y);
                  return <line key={item.txn.txnId} x1={core.x} y1={core.y} x2={target.x} y2={target.y} />;
                })}
              </g>
              <g className="action-link-group">
                {analysis.scenarios.slice(0, 2).map((scenario, index) => {
                  const core = nodePoint("journey-core", coreBasePosition.x, coreBasePosition.y);
                  const target = nodePoint(`scenario-${scenario.scenarioId}`, 1010, index === 0 ? 340 : 650);
                  return <path key={scenario.scenarioId} d={`M ${core.x} ${core.y} C 910 ${index === 0 ? 430 : 535}, 920 ${target.y}, ${target.x} ${target.y}`} />;
                })}
                {actionProducts.map((product, index) => {
                  const sourceScenario = analysis.scenarios[index < Math.ceil(actionProducts.length / 2) ? 0 : 1] ?? analysis.scenarios[0];
                  const sourceY = index < Math.ceil(actionProducts.length / 2) ? 340 : 650;
                  const source = nodePoint(`scenario-${sourceScenario.scenarioId}`, 1010, sourceY);
                  const target = nodePoint(`product-${product.productId}`, 1240 + (index % 2) * 180, 270 + Math.floor(index / 2) * 175);
                  return <path key={product.productId} d={`M ${source.x} ${source.y} C 1110 ${source.y}, ${target.x - 80} ${target.y}, ${target.x} ${target.y}`} />;
                })}
              </g>
            </svg>

            <div className="journey-branch-layer">
              <div className="journey-orbit orbit-one" /><div className="journey-orbit orbit-two" /><div className="journey-orbit orbit-three" />
              {branchNodes.map((item, index) => {
                const isCurrent = item.customer.customerId === analysis.customer.customerId;
                const isSimilar = similarCustomerIds.has(item.customer.customerId);
                const nodeId = `customer-${item.customer.customerId}`;
                return (
                  <button
                    key={item.customer.customerId}
                    className={`journey-customer-node journey-draggable-node ${isCurrent ? "is-current" : ""} ${isSimilar ? "is-similar" : ""}`}
                    style={nodeStyle(nodeId, item.position.x, item.position.y, 18 + (index % 3) * 14)}
                    onPointerDown={(event) => beginNodeDrag(event, nodeId)}
                    onClick={() => {
                      if (ignoreClickAfterDrag(nodeId)) return;
                      if (!isCurrent) {
                        onSelectCustomer(item.customer.customerId, () => goToScene(1));
                        return;
                      }
                      goToScene(1);
                    }}
                  >
                    <i>{String(index + 1).padStart(2, "0")}</i>
                    <strong>{item.customer.customerName.replace("有限公司", "")}</strong>
                    <span>{item.opportunity?.topScenario.replace("场景", "") ?? item.customer.industry}</span>
                    {sceneIndex === 3 && item.opportunity && <em>{money(item.opportunity.estimatedDepositIncrease)}</em>}
                  </button>
                );
              })}
            </div>

            <button
              key={sceneIndex === 0 || sceneIndex === 3 ? "branch-core" : "customer-core"}
              className={`journey-core-node journey-draggable-node ${sceneIndex === 0 || sceneIndex === 3 ? "is-branch-core" : "is-customer-core"}`}
              style={nodeStyle("journey-core", coreBasePosition.x, coreBasePosition.y, 92)}
              onPointerDown={(event) => beginNodeDrag(event, "journey-core")}
              onClick={() => {
                if (ignoreClickAfterDrag("journey-core")) return;
                goToScene(sceneIndex === 2 ? 2 : 1);
              }}
            >
              <span>{sceneIndex === 0 || sceneIndex === 3 ? "经营中枢" : "重点客户"}</span>
              <strong>{sceneIndex === 0 || sceneIndex === 3 ? dataset.branch.branchName : analysis.customer.customerName}</strong>
              <em>{sceneIndex === 0 || sceneIndex === 3 ? `${branch.customerCount} 户企业 · ${branch.opportunityCount} 户机会客户` : `${analysis.customer.industry} · ${analysis.customer.managerName}`}</em>
            </button>

            <div className="journey-evidence-layer" key={`evidence-${analysis.customer.customerId}-${sceneIndex}`}>
              {analysis.accounts.map((account, index) => (
                <article
                  className="journey-account-node journey-draggable-node"
                  key={account.accountId}
                  style={nodeStyle(`account-${account.accountId}`, index === 0 ? 560 : 1080, 360, 46)}
                  onPointerDown={(event) => beginNodeDrag(event, `account-${account.accountId}`)}
                >
                  <span>{account.accountType}</span><strong>{account.accountName}</strong><em>{money(account.balance)}</em>
                </article>
              ))}
              {plottedTransactions.map((item, index) => {
                const isEvidence = topScenario.evidenceTxnIds.includes(item.txn.txnId);
                const nodeId = `txn-${item.txn.txnId}`;
                return (
                  <button
                    className={`journey-txn-node journey-draggable-node ${item.txn.direction === "in" ? "is-income" : "is-outcome"} ${isEvidence ? "is-evidence" : ""} ${selectedTxnId === item.txn.txnId ? "is-selected" : ""}`}
                    key={item.txn.txnId}
                    style={nodeStyle(nodeId, item.x, item.y, 22 + (index % 4) * 8, { "--delay": `${index * 70}ms` } as CSSProperties)}
                    onPointerDown={(event) => beginNodeDrag(event, nodeId)}
                    onClick={() => {
                      if (ignoreClickAfterDrag(nodeId)) return;
                      setManualCamera(null);
                      setSceneIndex(1);
                      setSelectedTxnId(item.txn.txnId);
                    }}
                  >
                    <i />
                    <span>{item.txn.txnDate.slice(5)}</span>
                    <strong>{item.txn.counterpartyName}</strong>
                    <em>{item.txn.direction === "in" ? "+" : "−"}{money(item.txn.amount)}</em>
                  </button>
                );
              })}
            </div>

            <div className="journey-action-layer">
              {analysis.scenarios.slice(0, 2).map((scenario, index) => (
                <article
                  className="journey-scenario-node journey-draggable-node"
                  key={scenario.scenarioId}
                  style={nodeStyle(`scenario-${scenario.scenarioId}`, 1010, index === 0 ? 340 : 650, 58)}
                  onPointerDown={(event) => beginNodeDrag(event, `scenario-${scenario.scenarioId}`)}
                >
                  <span>经营场景 0{index + 1}</span><strong>{scenario.scenarioName}</strong><em>{percent(scenario.confidence)} · {scenario.evidenceRows.length}笔证据</em>
                </article>
              ))}
              {actionProducts.map((product, index) => {
                const usage = analysis.usages.find((item) => item.productId === product.productId);
                return (
                  <article
                    className={`journey-product-node journey-draggable-node ${usage?.activated ? "is-covered" : "is-gap"}`}
                    key={product.productId}
                    style={nodeStyle(`product-${product.productId}`, 1240 + (index % 2) * 180, 270 + Math.floor(index / 2) * 175, 38 + (index % 2) * 13, { "--delay": `${index * 95}ms` } as CSSProperties)}
                    onPointerDown={(event) => beginNodeDrag(event, `product-${product.productId}`)}
                  >
                    <span>{usage?.activated ? "已使用" : usage?.signed ? "已签约" : "产品缺口"}</span><strong>{product.productName}</strong><em>{product.productType}</em>
                  </article>
                );
              })}
              <article className="journey-battle-node journey-draggable-node" style={nodeStyle("battle-card", 1530, 500, 70)} onPointerDown={(event) => beginNodeDrag(event, "battle-card")}>
                <span>经营动作</span><strong>客户经理作战卡</strong><p>{analysis.bundles[0].verifyQuestion}</p><em>责任人 · {analysis.value.actionOwner}</em>
              </article>
            </div>
          </div>
        </div>

        {selectedTxn && (
          <aside className="journey-micro-panel">
            <span>原始流水证据</span><strong>{selectedTxn.counterpartyName}</strong>
            <dl><div><dt>日期</dt><dd>{selectedTxn.txnDate}</dd></div><div><dt>金额</dt><dd>{money(selectedTxn.amount)}</dd></div><div><dt>摘要</dt><dd>{selectedTxn.summary}</dd></div><div><dt>渠道</dt><dd>{selectedTxn.channel}</dd></div></dl>
            <p>关联判断：{topScenario.scenarioName}</p>
            <button type="button" className="journey-micro-back" onClick={() => { setSelectedTxnId(""); setManualCamera(null); }}>← 返回证据全景</button>
          </aside>
        )}

        <aside className="journey-scene-rail" aria-label="推演阶段">
          {scenes.map((scene, index) => <button key={scene.kicker} className={index === sceneIndex ? "is-active" : ""} onClick={() => goToScene(index)}><i /> <span>0{index + 1}</span><strong>{scene.kicker}</strong></button>)}
        </aside>

        <div className="journey-interaction-hint"><span>3D</span> 滚轮缩放 · 拖动画布 · 节点可移动</div>

        <footer className="journey-controls">
          <button onClick={() => goToScene(sceneIndex - 1)}>← 上一阶段</button>
          <div>{scenes.map((scene, index) => <button aria-label={scene.kicker} key={scene.kicker} className={index === sceneIndex ? "is-active" : ""} onClick={() => goToScene(index)} />)}</div>
          <button onClick={() => goToScene(sceneIndex + 1)}>下一阶段 →</button>
        </footer>
      </div>
    </section>
  );
}

function Loading() {
  return (
    <main className="center-shell skeleton-shell">
      <aside className="skeleton-panel">
        <div className="skeleton-block skeleton-hero" />
        <div className="skeleton-block skeleton-tag-row" />
        <div className="skeleton-block skeleton-metric" />
        <div className="skeleton-block skeleton-metric" />
      </aside>
      <section className="skeleton-stage">
        <div className="skeleton-block skeleton-step-bar" />
        <div className="skeleton-block skeleton-graph" />
        <div className="skeleton-block skeleton-insight-row" />
      </section>
      <aside className="skeleton-panel">
        <div className="skeleton-block skeleton-assistant-head" />
        <div className="skeleton-block skeleton-msg" />
        <div className="skeleton-block skeleton-msg" />
        <div className="skeleton-block skeleton-msg" />
      </aside>
    </main>
  );
}

function DataError({ message }: { message: string }) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <main className="center-shell">
      <section className="state-card">
        <p className="eyebrow">Data Source Error</p>
        <h1>无法读取本地 SQLite 数据。</h1>
        <p className="error-detail">{message}</p>
        <p>请先初始化数据库并启动后端 API 服务。</p>
        <div className="error-actions">
          <button className="primary-button" onClick={() => window.location.reload()}>重试加载</button>
          <button onClick={() => setShowHelp(!showHelp)}>{showHelp ? "收起帮助" : "如何启动后端服务？"}</button>
        </div>
        {showHelp && (
          <div className="error-help">
            <p>1. 进入 <code>apps/api/</code> 目录</p>
            <p>2. 运行 <code>python init_db.py</code> 初始化数据库</p>
            <p>3. 运行 <code>python main.py</code> 启动后端服务（默认端口 8787）</p>
            <p>4. 确认后端运行后点击"重试加载"</p>
          </div>
        )}
      </section>
    </main>
  );
}

function TopBar({
  customers,
  selectedCustomerId,
  onSelectCustomer,
  viewMode,
  onSelectView,
}: {
  customers: Customer[];
  selectedCustomerId: string;
  onSelectCustomer: (customerId: string) => void;
  viewMode: "story" | "workbench";
  onSelectView: (mode: "story" | "workbench") => void;
}) {
  return (
    <header className="top-bar">
      <div className="brand-lockup">
        <span>SI</span>
        <div>
          <strong>结算业务智能盘户</strong>
          <small>工作台</small>
        </div>
      </div>
      <nav className="view-mode-switch" aria-label="页面模式">
        <button className={viewMode === "story" ? "is-active" : ""} onClick={() => onSelectView("story")}>全景推演</button>
        <button className={viewMode === "workbench" ? "is-active" : ""} onClick={() => onSelectView("workbench")}>详细工作台</button>
      </nav>
      <label className="customer-picker">
        <span>当前客户</span>
        <select value={selectedCustomerId} onChange={(event) => onSelectCustomer(event.target.value)}>
          {customers.map((customer) => (
            <option key={customer.customerId} value={customer.customerId}>
              {customer.customerName}
            </option>
          ))}
        </select>
      </label>
    </header>
  );
}

function CustomerPanel({
  analysis,
  branch,
  activeStep,
}: {
  analysis: CustomerAnalysis;
  branch: BranchAnalysis;
  activeStep: OntologyStep;
}) {
  const branchAvgBalance = branch.totalDepositIncrease / Math.max(branch.opportunityCount, 1);
  const balanceTrend = analysis.features.currentBalance > analysis.features.avgBalance90d ? "up" : "down";
  const balanceDiff = Math.abs(analysis.features.currentBalance - analysis.features.avgBalance90d);
  const balanceDiffPercent = analysis.features.avgBalance90d > 0 ? Math.round((balanceDiff / analysis.features.avgBalance90d) * 100) : 0;
  const isCustomerStep = activeStep.id === "customer";
  const visibleTags = isCustomerStep
    ? [analysis.customer.industry, analysis.customer.customerTier, analysis.customer.branchName]
    : analysis.customer.tags;

  return (
    <aside className="customer-panel">
      <section className="customer-profile-block">
        <div className="customer-hero-card">
          <h1>{analysis.customer.customerName}</h1>
          <div className="customer-meta">
            <span>{analysis.customer.industry}</span>
            <span>{analysis.customer.customerTier}</span>
            <span>{analysis.customer.managerName}</span>
          </div>
        </div>
        <div className="tag-cloud">
          {visibleTags.map((tag) => (
            <span key={tag} className="tag-item">{tag}</span>
          ))}
        </div>
        <div className="metric-stack">
          <div className="metric metric-primary">
            <span>当前余额</span>
            <strong>{money(analysis.features.currentBalance)}</strong>
            <em className={`trend-indicator trend-${balanceTrend}`}>{balanceTrend === "up" ? "↑" : "↓"} 较90日均额 {balanceDiffPercent}%</em>
          </div>
          <Metric label="90 日均额" value={money(analysis.features.avgBalance90d)} />
          {isCustomerStep ? (
            <>
              <Metric label="账户数量" value={`${analysis.accounts.length} 个`} />
              <Metric label="近 90 日流水" value={`${analysis.transactions.length} 笔`} />
              <Metric label="产品使用记录" value={`${analysis.usages.length} 项`} />
            </>
          ) : (
            <>
              <Metric label="支行机会客户" value={`${branch.opportunityCount} 户`} />
              <Metric label="支行预计沉淀" value={money(branch.totalDepositIncrease)} />
              <div className="metric metric-compare">
                <span>较支行均值</span>
                <strong className={analysis.features.currentBalance > branchAvgBalance ? "above-average" : "below-average"}>
                  {analysis.features.currentBalance > branchAvgBalance ? "↑ 高于" : "↓ 低于"} {money(Math.abs(analysis.features.currentBalance - branchAvgBalance))}
                </strong>
              </div>
            </>
          )}
        </div>
      </section>
    </aside>
  );
}

function WorkflowMap({ activeStep, activeStepIndex, analysis, onSelectStep }: { activeStep: OntologyStep; activeStepIndex: number; analysis: CustomerAnalysis; onSelectStep: (index: number) => void }) {
  const topNeed = analysis.needs[0];
  const topScenario = analysis.scenarios[0];
  const topBundle = analysis.bundles[0];

  const STEP_RESULTS: Record<OntologyStep["id"], string> = {
    customer: `${analysis.customer.industry} · ${analysis.customer.branchName}`,
    need: topNeed.needType,
    scenario: topScenario.scenarioName,
    product: topBundle.bundleName,
    process: topBundle.verifyQuestion,
    usage: analysis.coverage[0]?.status ?? "已覆盖",
    value: `预计沉淀 ${money(analysis.value.estimatedDepositIncrease)}`,
  };

  return (
    <header className="workflow-map" id="workflow" aria-label="结算本体链路" data-active-step={activeStep.id}>
      <button
        type="button"
        className="workflow-direction-control is-previous"
        disabled={activeStepIndex === 0}
        onClick={() => onSelectStep(activeStepIndex - 1)}
      >
        <span>←</span><strong>上一步</strong>
      </button>
      <div className="workflow-track">
        <div className="workflow-progress" style={{ "--workflow-progress": `${(activeStepIndex / (ontologySteps.length - 1)) * 100}%` } as CSSProperties} />
        <div className="workflow-steps">
          {ontologySteps.map((step, index) => (
            <button
              type="button"
              className={`workflow-step ${index < activeStepIndex ? "is-done" : ""} ${index === activeStepIndex ? "is-active" : ""}`}
              key={step.id}
              title={STEP_RESULTS[step.id]}
              onClick={() => onSelectStep(index)}
            >
              <span className="workflow-step-dot">{index < activeStepIndex ? "✓" : index + 1}</span>
              <strong>{step.label}</strong>
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="workflow-direction-control is-next"
        disabled={activeStepIndex === ontologySteps.length - 1}
        onClick={() => onSelectStep(activeStepIndex + 1)}
      >
        <strong>下一步</strong><span>→</span>
      </button>
    </header>
  );
}

function GraphOverview({
  activeStepIndex,
  analysis,
  nodeAnalyses,
  onSelectStep,
}: {
  activeStepIndex: number;
  analysis: CustomerAnalysis;
  nodeAnalyses: NodeAnalysis[];
  onSelectStep: (index: number) => void;
}) {
  const graphViews = useMemo(() => buildGraphViews(nodeAnalyses, activeStepIndex, ontologySteps.map((step) => step.label)), [activeStepIndex, nodeAnalyses]);
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hoveredNodeId, setHoveredNodeId] = useState("");
  const [releasedNodeId, setReleasedNodeId] = useState("");
  const dragRef = useRef<{ id?: string; mode: "node" | "rotate"; moved: boolean; velocity: number; x: number; y: number } | null>(null);
  const cardDragRef = useRef<{ x: number; y: number } | null>(null);
  const detailCardRef = useRef<HTMLElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [detailCardPos, setDetailCardPos] = useState<{ x: number; y: number }>({ x: 14, y: 14 });
  const inertiaFrameRef = useRef<number | null>(null);
  const featuredViews = [graphViews[0], ...graphViews.slice(1, 6)];
  const displayedViews = featuredViews.map((node) => ({
    ...node,
    ...rotateGraphPoint(node.x + (nodeOffsets[node.id]?.x ?? 0), node.y + (nodeOffsets[node.id]?.y ?? 0), rotation),
  }));
  const coreViews = displayedViews.filter((node) => node.type === "core");
  const activeView = coreViews[coreViews.length - 1] ?? graphViews[0];
  const edges = buildGraphEdges(displayedViews);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const selectedNode = findGraphNode(displayedViews, selectedNodeId);
  const [showGuide, setShowGuide] = useState(false);
  const timelineEvents = Array.from(
    [...analysis.transactions]
      .sort((a, b) => a.txnDate.localeCompare(b.txnDate))
      .reduce((months, txn) => {
        months.set(txn.txnDate.slice(0, 7), txn);
        return months;
      }, new Map<string, CustomerAnalysis["transactions"][number]>())
      .entries(),
  ).slice(-3);

  useEffect(() => {
    setSelectedNodeId("");
    setNodeOffsets({});
    setRotation(0);
    setZoom(1);
    setHoveredNodeId("");
  }, [activeView.id]);

  useEffect(() => () => {
    if (inertiaFrameRef.current) cancelAnimationFrame(inertiaFrameRef.current);
  }, []);

  function startRotate(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    if (inertiaFrameRef.current) cancelAnimationFrame(inertiaFrameRef.current);
    dragRef.current = { mode: "rotate", moved: false, velocity: 0, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startNodeDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    dragRef.current = { id, mode: "node", moved: false, velocity: 0, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGraph(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    let dx = event.clientX - drag.x;
    let dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.mode === "rotate") {
      drag.velocity = dx * 0.24;
      setRotation((current) => current + drag.velocity);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!drag.id || !rect.width || !rect.height) return;
    const radians = -(rotation * Math.PI) / 180;
    const rdx = dx * Math.cos(radians) - dy * Math.sin(radians);
    const rdy = dx * Math.sin(radians) + dy * Math.cos(radians);
    setNodeOffsets((current) => ({
      ...current,
      [drag.id as string]: {
        x: (current[drag.id as string]?.x ?? 0) + (rdx / rect.width) * 100,
        y: (current[drag.id as string]?.y ?? 0) + (rdy / rect.height) * 100,
      },
    }));
  }

  function stopGraphDrag() {
    const drag = dragRef.current;
    if (drag?.mode === "rotate" && Math.abs(drag.velocity) > 0.12) startRotationInertia(drag.velocity);
    if (drag?.mode === "node" && drag.id) {
      setReleasedNodeId(drag.id);
      window.setTimeout(() => setReleasedNodeId(""), 520);
    }
    window.setTimeout(() => {
      dragRef.current = null;
    }, 0);
  }

  function startRotationInertia(initialVelocity: number) {
    let velocity = initialVelocity;
    function tick() {
      velocity *= 0.92;
      if (Math.abs(velocity) < 0.04) return;
      setRotation((current) => current + velocity);
      inertiaFrameRef.current = requestAnimationFrame(tick);
    }
    inertiaFrameRef.current = requestAnimationFrame(tick);
  }

  function zoomGraph(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    setZoom((current) => clamp(current - event.deltaY * 0.001, 0.72, 1.45));
  }

  function resetGraph() {
    setNodeOffsets({});
    setRotation(0);
    setZoom(1);
    setSelectedNodeId("");
  }

  return (
    <section className="graph-overview" aria-label="递进式本体分析图谱">
      <div className="graph-copy" style={{ "--tone": activeView.tone } as CSSProperties}>
        <div className="graph-step-count">推理章节 {String(activeStepIndex + 1).padStart(2, "0")} / {String(ontologySteps.length).padStart(2, "0")}</div>
        <p className="graph-stage-label">结算智图 · 全局态</p>
        <h3>{activeView.label}</h3>
        <strong>{activeView.analysis.result}</strong>
        <p>{activeView.analysis.title}</p>
        <div className="graph-evidence-list">
          {activeView.analysis.evidence.slice(0, 3).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <div className="graph-timeline" aria-label="经营事件时间轴">
          <p>经营时间轴</p>
          {timelineEvents.map(([month, txn]) => (
            <button key={month} onClick={() => setSelectedNodeId("")}>
              <span>{month.replace("2026-", "")}</span>
              <strong>{txn.summary}</strong>
              <small>{txn.direction === "in" ? "+" : "−"}{money(txn.amount)}</small>
            </button>
          ))}
        </div>
      </div>
      <div
        className={`graph-canvas-wrap layout-${activeView.analysis.stepId} ${selectedNode ? "has-focus" : ""}`}
        ref={canvasWrapRef}
        style={{
          "--focus-x": `${selectedNode?.x ?? 50}%`,
          "--focus-y": `${selectedNode?.y ?? 52}%`,
        } as CSSProperties}
        onPointerDown={(e) => {
          if (showGuide) { setShowGuide(false); sessionStorage.setItem("graph-guide-seen", "1"); return; }
          startRotate(e);
        }}
        onPointerMove={moveGraph}
        onPointerUp={stopGraphDrag}
        onWheel={zoomGraph}
      >
        <div className="graph-toolbar">
          <span><i className="legend-path" />已完成推导</span>
          <span><i className="legend-current" />本环实体</span>
          <strong>{featuredViews.length - 1} 个重点实体 · {edges.length} 条关系</strong>
          <button onClick={() => setZoom((current) => clamp(current + 0.12, 0.72, 1.45))}>+</button>
          <button onClick={() => setZoom((current) => clamp(current - 0.12, 0.72, 1.45))}>−</button>
          <button onClick={resetGraph}>复位</button>
          <button aria-label="查看图谱交互说明" onClick={() => setShowGuide(true)}>?</button>
        </div>
        <div className="graph-transform-layer" style={{ "--zoom": zoom } as CSSProperties}>
          <svg className="graph-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id="graph-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                <path d="M0,0 L6,3 L0,6 Z" />
              </marker>
            </defs>
            {edges.map((edge) => (
              <g key={edge.id}>
                <line
                  className={`${edge.type === "child" ? "is-child" : "is-core"} ${hoveredNodeId && edge.source.id !== hoveredNodeId && edge.target.id !== hoveredNodeId ? "is-muted" : ""}`}
                  x1={edge.source.x}
                  y1={edge.source.y}
                  x2={edge.target.x}
                  y2={edge.target.y}
                />
              </g>
            ))}
          </svg>
          <div className="graph-edge-labels">
            {edges.map((edge) => (
              <span
                className={hoveredNodeId && edge.source.id !== hoveredNodeId && edge.target.id !== hoveredNodeId ? "is-muted" : ""}
                key={edge.id}
                style={{ "--x": `${(edge.source.x + edge.target.x) / 2}%`, "--y": `${(edge.source.y + edge.target.y) / 2}%` } as CSSProperties}
              >
                {edge.label}
              </span>
            ))}
          </div>
          <div className="graph-node-labels">
            {displayedViews.map((node) => {
              const kind = graphNodeKind(node);
              return (
                <button
                  className={`${node.type === "child" ? "is-child" : "is-core"} kind-${kind} ${node.type === "core" ? "is-active" : ""} ${node.id === selectedNodeId ? "is-selected" : ""} ${node.id === releasedNodeId ? "is-released" : ""}`}
                  key={node.id}
                  title={node.type === "core" ? node.analysis.result : node.detail}
                  onClick={() => {
                    if (dragRef.current?.moved) return;
                    if (node.type === "core" && node.index !== activeStepIndex) onSelectStep(node.index);
                    setSelectedNodeId(node.id);
                  }}
                  onPointerDown={(event) => startNodeDrag(event, node.id)}
                  onPointerEnter={() => setHoveredNodeId(node.id)}
                  onPointerLeave={() => setHoveredNodeId("")}
                  style={{ "--x": `${node.x}%`, "--y": `${node.y}%` } as CSSProperties}
                >
                  <span className="graph-node-orb" aria-hidden="true">
                    <GraphNodeIcon kind={kind} />
                  </span>
                  <span className="graph-node-badge">{node.type === "core" ? "当前核心" : node.badge}</span>
                  <strong>{node.label}</strong>
                </button>
              );
            })}
          </div>
        </div>
        <div className="graph-interaction-hint">点击节点聚焦推理 · 滚轮缩放 · 拖动画布查看关联</div>
        {showGuide && (
          <div className="graph-guide-overlay" onClick={() => { setShowGuide(false); sessionStorage.setItem("graph-guide-seen", "1"); }}>
            <div className="graph-guide-card">
              <p className="eyebrow">图谱交互指南</p>
              <h4>3 步探索本体图谱</h4>
              <ol>
                <li><strong>点击节点</strong> — 查看实体详情和关联证据</li>
                <li><strong>拖动画布</strong> — 旋转整个图谱视角</li>
                <li><strong>滚轮缩放</strong> — 放大或缩小视图</li>
              </ol>
              <button className="primary-button" onClick={() => { setShowGuide(false); sessionStorage.setItem("graph-guide-seen", "1"); }}>开始探索</button>
            </div>
          </div>
        )}
        {selectedNode && (
          <article
            ref={detailCardRef}
            className="graph-detail-card"
            style={{ left: `${detailCardPos.x}px`, top: `${detailCardPos.y}px` }}
            onPointerDown={(e) => {
              const target = e.target as HTMLElement;
              if (target.closest(".graph-detail-close")) return;
              e.stopPropagation();
              e.preventDefault();
              const el = detailCardRef.current;
              if (!el) return;
              el.setPointerCapture(e.pointerId);
              cardDragRef.current = { x: e.clientX - detailCardPos.x, y: e.clientY - detailCardPos.y };
            }}
            onPointerMove={(e) => {
              if (!cardDragRef.current) return;
              const wrap = canvasWrapRef.current;
              const card = detailCardRef.current;
              if (!wrap || !card) return;
              const wrapRect = wrap.getBoundingClientRect();
              const cardWidth = card.offsetWidth;
              const cardHeight = card.offsetHeight;
              const x = Math.min(Math.max(0, e.clientX - cardDragRef.current.x), wrapRect.width - cardWidth);
              const y = Math.min(Math.max(0, e.clientY - cardDragRef.current.y), wrapRect.height - cardHeight);
              setDetailCardPos({ x, y });
            }}
            onPointerUp={() => { cardDragRef.current = null; }}
            onLostPointerCapture={() => { cardDragRef.current = null; }}
          >
            <button className="graph-detail-close" aria-label="关闭节点详情" onClick={() => setSelectedNodeId("")}>×</button>
            <p>关联推演 · {selectedNode.badge}</p>
            <h4>{selectedNode.label}</h4>
            <span>{selectedNode.relation}</span>
            <strong>{selectedNode.detail}</strong>
            <ul>
              {selectedNode.details.filter((item) => {
                if (item === selectedNode.detail) return false;
                if (item.includes(selectedNode.label) && selectedNode.label.length > 6) return false;
                return true;
              }).slice(0, 5).map((item) => <li key={item}>{item}</li>)}
            </ul>
          </article>
        )}
      </div>
    </section>
  );
}

type GraphNodeKind = "account" | "company" | "core" | "metric" | "person" | "process" | "product" | "rule" | "value";

function graphNodeKind(node: ReturnType<typeof buildGraphViews>[number]): GraphNodeKind {
  if (node.type === "core") return "core";
  const badge = node.badge;
  const text = `${node.badge} ${node.label} ${node.detail} ${node.relation}`;
  const stepId = node.analysis.stepId;

  if (/实际控制人|财务负责人|总经理|责任人|客户经理/.test(badge)) return "person";
  if (/基本户|一般户|账户|流水证据|场景流水/.test(badge)) return "account";
  if (/开户支行|关联企业|产业链|上游经营主体|下游经营主体/.test(text)) return "company";
  if (/客户标签|上游标签|下游标签|余额指标|资金指标|行为指标|使用指标|识别规则|机会评分/.test(badge)) return "rule";
  if (/留存参数|承接参数/.test(badge)) return "value";
  if (/产品|组合缺口|覆盖诊断|使用深度/.test(badge) || stepId === "product" || stepId === "usage") return "product";
  if (/办理动作/.test(badge) || stepId === "process") return "process";
  if (stepId === "scenario") return "metric";
  if (stepId === "need") return /余额|指标/.test(text) ? "rule" : "account";
  if (stepId === "value") return "value";

  if (/控制人|负责人|总经理|责任人|客户经理/.test(text)) return "person";
  if (/基本户|一般户|账户|流水|交易|资金|存款/.test(text)) return "account";
  if (/产品|组合|缺口|签约|激活|覆盖/.test(text)) return "product";
  if (/办理|材料|动作|流程|问题|话术/.test(text)) return "process";
  if (/规则|识别|权重|置信|指标|评分|参数|标签/.test(text)) return "rule";
  if (/价值|留存|承接|提升|沉淀|机会/.test(text)) return "value";
  if (/产业|行业|场景/.test(text)) return "metric";
  return "company";
}

function GraphNodeIcon({ kind }: { kind: GraphNodeKind }) {
  if (kind === "person") {
    return (
      <svg viewBox="0 0 24 24" role="img">
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 19c.8-3.5 3-5.2 6.5-5.2s5.7 1.7 6.5 5.2" />
      </svg>
    );
  }
  if (kind === "account") {
    return (
      <svg viewBox="0 0 24 24" role="img">
        <path d="M4 9h16" />
        <path d="M6 9V7.5L12 4l6 3.5V9" />
        <path d="M7 10.5V17M12 10.5V17M17 10.5V17" />
        <path d="M5 19h14" />
      </svg>
    );
  }
  if (kind === "product") {
    return (
      <svg viewBox="0 0 24 24" role="img">
        <path d="M5 8.5 12 5l7 3.5v7L12 19l-7-3.5z" />
        <path d="m5 8.5 7 3.5 7-3.5M12 12v7" />
      </svg>
    );
  }
  if (kind === "process") {
    return (
      <svg viewBox="0 0 24 24" role="img">
        <path d="M7 6h10M7 12h10M7 18h6" />
        <circle cx="4" cy="6" r="1" />
        <circle cx="4" cy="12" r="1" />
        <circle cx="4" cy="18" r="1" />
      </svg>
    );
  }
  if (kind === "rule" || kind === "metric") {
    return (
      <svg viewBox="0 0 24 24" role="img">
        <path d="M5 18V9M12 18V5M19 18v-7" />
        <path d="M4 19h16" />
      </svg>
    );
  }
  if (kind === "value") {
    return (
      <svg viewBox="0 0 24 24" role="img">
        <path d="m5 15 4-4 3 3 7-7" />
        <path d="M16 7h3v3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" role="img">
      <path d="M7 20V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V20" />
      <path d="M5 20h14M10 8h1M13 8h1M10 12h1M13 12h1M10 16h1M13 16h1" />
    </svg>
  );
}

function InsightGrid({
  activeStep,
  nodeAnalyses,
  analysis,
  statementResult,
  asrResult,
  onOpenAsrTool,
  onOpenStatementTool,
}: {
  activeStep: OntologyStep;
  nodeAnalyses: NodeAnalysis[];
  analysis: CustomerAnalysis;
  statementResult?: StatementAnalysisResult;
  asrResult?: AsrTranscriptionResult;
  onOpenAsrTool: () => void;
  onOpenStatementTool: () => void;
}) {
  const activeAnalysis = nodeAnalyses.find((item) => item.stepId === activeStep.id) ?? nodeAnalyses[0];
  const topScenario = analysis.scenarios[0];
  if (activeStep.id === "customer") {
    return (
      <section className="insight-grid customer-foundation-grid">
        <article className="insight-card customer-subject-card">
          <p>主体档案</p>
          <h3>{analysis.customer.customerName}</h3>
          <span>客户号 {analysis.customer.customerId} · {analysis.customer.industry}</span>
        </article>
        <InsightCard label="责任归属" value={analysis.customer.managerName} body={`${analysis.customer.branchName} · ${analysis.customer.customerTier}`} />
        <InsightCard label="账户范围" value={`${analysis.accounts.length} 个账户`} body={`当前余额合计 ${money(analysis.features.currentBalance)}`} />
        <InsightCard label="数据入口" value={`${analysis.transactions.length} 笔流水`} body={`${analysis.usages.length} 项产品使用记录`} />
      </section>
    );
  }
  if (activeStep.id === "need") {
    return (
      <section className="insight-grid need-insight-grid">
        <StatementToolCard analysis={analysis} result={statementResult} onOpen={onOpenStatementTool} />
        <AsrToolCard analysis={analysis} result={asrResult} onOpen={onOpenAsrTool} />
      </section>
    );
  }
  if (activeStep.id === "scenario") {
    const triggerNeed = analysis.needs.find((item) => item.needId === topScenario.triggerNeedId) ?? analysis.needs[0];
    return (
      <section className="insight-grid scenario-context-grid">
        <InsightCard label="触发需求" value={triggerNeed?.needType ?? "待识别"} body="承接上一环节已识别的资金需求。" />
        <InsightCard label="经营活动" value={topScenario.scenarioName} body={topScenario.evidence} />
        <InsightCard label="证据范围" value={`${topScenario.evidenceRows.length} 笔场景流水`} body="下方集中核对交易对象、方向与摘要。" />
      </section>
    );
  }
  const evidenceCards = activeAnalysis.evidence.slice(0, 2).map((evidence, index) => (
    <InsightCard key={evidence} label={`分析依据 ${index + 1}`} value={evidence} body={index === 0 ? "系统抽取的第一条证据或业务判断。" : "用于支撑当前节点结论的补充依据。"} />
  ));

  return (
    <section className={`insight-grid insight-grid-${2 + evidenceCards.length}`}>
      <InsightCard label="当前结论" value={activeAnalysis.result} body={STEP_HINTS[activeStep.id]} />
      <InsightCard label="关键指标" value={activeAnalysis.metric} body={topScenario.evidence} />
      {evidenceCards}
    </section>
  );
}

function AsrToolCard({ analysis, result, onOpen }: { analysis: CustomerAnalysis; result?: AsrTranscriptionResult; onOpen: () => void }) {
  const waveform = [34, 58, 82, 48, 72, 92, 66, 42, 78, 54, 88, 64, 38, 70, 50, 80, 62, 44];
  return (
    <article className="insight-card statement-tool-card asr-tool-card">
      <div className="need-tool-copy">
        <div className="need-tool-status"><i />客户访谈录音分析<span>{result ? "已转写" : "待上传"}</span></div>
        <h3>用客户原话校准资金诉求</h3>
        <p>识别资金计划、期限偏好和流程痛点，避免只凭流水推断需求。</p>
      </div>
      <div className="need-tool-preview asr-tool-preview" aria-label={result ? "访谈转写结果预览" : "访谈录音工具示例预览"}>
        <div className="tool-preview-top"><span>{result ? "转写片段" : "示例预览"}</span><em>{result?.durationSeconds ? `${result.durationSeconds} 秒` : "AUDIO"}</em></div>
        <div className="audio-waveform" aria-hidden="true">
          {waveform.map((height, index) => <i key={`${height}-${index}`} style={{ "--wave-height": `${height}%` } as CSSProperties} />)}
        </div>
        <p>{result ? `“${result.text.slice(0, 58)}${result.text.length > 58 ? "…" : ""}”` : "录音转写将在这里呈现，并同步显示在下方研判区。"}</p>
      </div>
      <footer className="need-tool-footer">
        <span>{result ? `模型：${result.model}` : `客户：${analysis.customer.customerName}`}</span>
        <button type="button" className="primary-button statement-tool-open" onClick={onOpen}>{result ? "查看结果" : "打开工具"}</button>
      </footer>
    </article>
  );
}

function StatementToolCard({ analysis, result, onOpen }: { analysis: CustomerAnalysis; result?: StatementAnalysisResult; onOpen: () => void }) {
  const previewRows = result
    ? result.transactions.slice(0, 3).map((item) => ({ name: item.counterparty, amount: item.amount, direction: item.direction }))
    : analysis.transactions.slice(0, 3).map((item) => ({ name: item.counterpartyName, amount: item.amount, direction: item.direction }));
  return (
    <article className="insight-card statement-tool-card">
      <div className="need-tool-copy">
        <div className="need-tool-status"><i />流水影像分析<span>{result ? "已解析" : "待上传"}</span></div>
        <h3>把行外影像变成资金证据</h3>
        <p>提取交易明细、对手方与资金流向，并在下方展示本次分析结论。</p>
      </div>
      <div className="need-tool-preview statement-tool-preview" aria-label={result ? "流水影像解析结果预览" : "流水影像工具示例预览"}>
        <div className="tool-preview-top"><span>{result ? "解析结果" : "业务数据预览"}</span><em>{result ? `${result.summary.transactionCount} 条` : "OCR"}</em></div>
        <div className="statement-preview-head"><i />企业流水明细</div>
        <div className="statement-preview-rows">
          {previewRows.map((row, index) => (
            <div key={`${row.name}-${index}`}><span>{row.name}</span><strong className={row.direction === "in" ? "is-income" : "is-outcome"}>{row.direction === "in" ? "+" : "-"}{money(row.amount)}</strong></div>
          ))}
        </div>
      </div>
      <footer className="need-tool-footer">
        <span>{result ? `来源：${result.source === "local_stub" ? "本地演示解析" : "TextIn 双接口"}` : `当前需求：${analysis.needs[0]?.needType ?? "待识别"}`}</span>
        <button type="button" className="primary-button statement-tool-open" onClick={onOpen}>{result ? "查看结果" : "打开工具"}</button>
      </footer>
    </article>
  );
}

function StatementAnalyzerDialog({
  analysis,
  initialResult,
  onAnalysisComplete,
  onClose,
}: {
  analysis: CustomerAnalysis;
  initialResult?: StatementAnalysisResult;
  onAnalysisComplete: (result: StatementAnalysisResult) => void;
  onClose: () => void;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [result, setResult] = useState<StatementAnalysisResult | null>(initialResult ?? null);
  const [status, setStatus] = useState<"idle" | "parsing" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [activeResultTab, setActiveResultTab] = useState<StatementResultTab>("recognition");
  const [previewUrl, setPreviewUrl] = useState("");
  const [qaMessages, setQaMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function parseSelectedFile(file = selectedFile) {
    if (!file) {
      setError("请先选择一份流水影像或 PDF。");
      setStatus("error");
      return;
    }
    setStatus("parsing");
    setError("");
    try {
      const nextResult = await analyzeStatement(file, analysis.customer.customerName);
      setResult(nextResult);
      onAnalysisComplete(nextResult);
      setActiveResultTab("extraction");
      setQaMessages([
        {
          role: "assistant",
          text: nextResult.conclusions.join("\n"),
        },
      ]);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "流水解析失败。");
      setStatus("error");
    }
  }

  function handleFileChange(file: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(file ? URL.createObjectURL(file) : "");
    setResult(null);
    setQaMessages([]);
    setStatus("idle");
    setError("");
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!result || !question.trim()) return;
    const answer = answerStatementQuestion(question, result);
    setQaMessages((messages) => [
      ...messages,
      { role: "user", text: question },
      { role: "assistant", text: answer },
    ]);
    setQuestion("");
  }

  function downloadStructuredResult() {
    if (!result) return;
    const csv = buildStatementCsv(result);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${result.fileName.replace(/\.[^.]+$/, "") || "statement"}-structured.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="statement-modal" role="dialog" aria-modal="true" aria-label="流水影像分析工具">
      <button className="statement-modal-backdrop" type="button" aria-label="关闭流水影像分析工具" onClick={onClose} />
      <section className="statement-modal-panel">
        <header className="statement-modal-head">
          <div>
            <p className="eyebrow">流水影像分析工具</p>
            <h2>{analysis.customer.customerName}</h2>
          </div>
          <button type="button" aria-label="关闭流水影像分析工具" onClick={onClose}>×</button>
        </header>
        <div className="statement-modal-body">
          <section className="statement-upload-panel">
            <button
              type="button"
              className="statement-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                handleFileChange(event.dataTransfer.files[0] ?? null);
              }}
            >
              <strong>{selectedFile ? selectedFile.name : "选择或拖入流水影像"}</strong>
              <span>png / jpg / jpeg / pdf / bmp / tiff / webp</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.pdf,.bmp,.tiff,.tif,.webp,image/*,application/pdf"
              onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
              hidden
            />
            <button type="button" className="primary-button" disabled={status === "parsing"} onClick={() => parseSelectedFile()}>
              {status === "parsing" ? "解析中..." : "开始解析"}
            </button>
            {error && <p className="statement-error">{error}</p>}
            <div className="statement-provider-note">
              <strong>{result?.source === "textin_xparse_extract_v3" ? "TextIn 双接口" : "TextIn 接入位"}</strong>
              <span>{result?.source === "local_stub" ? "当前展示本地演示解析结果。" : "左侧保留原始影像，右侧展示智能解析与智能抽取结果。"}</span>
            </div>
          </section>
          <StatementReviewPanel
            activeTab={activeResultTab}
            file={selectedFile}
            previewUrl={previewUrl}
            result={result}
            onDownload={downloadStructuredResult}
            onSelectTab={setActiveResultTab}
          />
          <section className="statement-qa-panel">
            <div className="statement-qa-log">
              {(qaMessages.length ? qaMessages : [{ role: "assistant" as const, text: "解析完成后，可以追问收入合计、付款集中度、主要交易对手、资金需求判断等问题。" }]).map((message, index) => (
                <div className={`message ${message.role}`} key={`${message.role}-${index}`}>{message.text}</div>
              ))}
            </div>
            <form className="chat-form" onSubmit={submitQuestion}>
              <input value={question} onChange={(event) => setQuestion(event.target.value)} disabled={!result} placeholder="追问流水影像内容..." />
              <button type="submit" disabled={!result}>发送</button>
            </form>
          </section>
        </div>
      </section>
    </div>
  );
}

function StatementReviewPanel({
  activeTab,
  file,
  onDownload,
  onSelectTab,
  previewUrl,
  result,
}: {
  activeTab: StatementResultTab;
  file: File | null;
  onDownload: () => void;
  onSelectTab: (tab: StatementResultTab) => void;
  previewUrl: string;
  result: StatementAnalysisResult | null;
}) {
  return (
    <section className="statement-review-panel">
      <div className="statement-preview-pane">
        {previewUrl ? (
          file?.type === "application/pdf" ? (
            <iframe src={previewUrl} title="流水 PDF 预览" />
          ) : (
            <img src={previewUrl} alt="流水影像预览" />
          )
        ) : (
          <div className="statement-preview-empty">上传后显示原始影像</div>
        )}
      </div>
      <div className="statement-result-panel">
        {result ? (
          <>
            <div className="statement-result-tabs">
              <button type="button" className={activeTab === "recognition" ? "is-active" : ""} onClick={() => onSelectTab("recognition")}>智能解析</button>
              <button type="button" className={activeTab === "extraction" ? "is-active" : ""} onClick={() => onSelectTab("extraction")}>流水抽取</button>
              <button type="button" className={activeTab === "analysis" ? "is-active" : ""} onClick={() => onSelectTab("analysis")}>分析结论</button>
            </div>
            {activeTab === "recognition" && <RecognitionResultView result={result} />}
            {activeTab === "extraction" && <ExtractionResultView result={result} onDownload={onDownload} />}
            {activeTab === "analysis" && <StatementAnalysisView result={result} />}
          </>
        ) : (
          <div className="statement-empty-state">
            <strong>解析后将在这里展示 TextIn 识别结果和抽取结果。</strong>
            <span>左侧保留原始影像，右侧用于核对 Markdown、结构化字段和流水明细。</span>
          </div>
        )}
      </div>
    </section>
  );
}

function RecognitionResultView({ result }: { result: StatementAnalysisResult }) {
  const elementCount = result.recognition.elements.length;
  return (
    <div className="statement-recognition-view">
      <div className="statement-summary-grid">
        <Metric label="解析页数" value={`${result.recognition.successCount ?? 0} 页`} />
        <Metric label="元素数量" value={`${elementCount} 个`} />
        <Metric label="耗时" value={`${result.recognition.durationMs ?? 0} ms`} />
        <Metric label="Schema" value={result.recognition.schemaVersion ?? "-"} />
      </div>
      <pre className="statement-markdown-preview">{result.recognition.markdown}</pre>
    </div>
  );
}

function ExtractionResultView({ result, onDownload }: { result: StatementAnalysisResult; onDownload: () => void }) {
  return (
    <div className="statement-extraction-view">
      <div className="statement-summary-grid">
        <Metric label="抽取流水" value={`${result.summary.transactionCount} 条`} />
        <Metric label="收入合计" value={money(result.summary.incomeTotal)} />
        <Metric label="支出合计" value={money(result.summary.outcomeTotal)} />
        <Metric label="净现金流" value={money(result.summary.netCashFlow)} />
      </div>
      <div className="statement-extraction-meta">
        <span>接口：智能文档抽取 v3</span>
        <span>请求：{result.extraction.requestId || "-"}</span>
      </div>
      <div className="statement-table">
        {result.transactions.map((txn, index) => (
          <article key={txn.id ?? `${txn.date}-${index}`}>
            <span className={txn.direction === "in" ? "income" : "outcome"}>{txn.direction === "in" ? "收入" : "支出"}</span>
            <div>
              <strong>{txn.counterparty}</strong>
              <p>{txn.date} / {txn.summary} / {txn.channel || "渠道待识别"}</p>
            </div>
            <em>{money(txn.amount)}</em>
          </article>
        ))}
      </div>
      <button type="button" className="statement-download-button" onClick={onDownload}>下载 CSV 流水文件</button>
    </div>
  );
}

function StatementAnalysisView({ result }: { result: StatementAnalysisResult }) {
  return (
    <div className="statement-analysis-view">
      <div className="statement-conclusions">
        {result.conclusions.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </div>
      <div className="statement-counterparty-list">
        {result.summary.topCounterparties.map((item) => (
          <article key={item.name}>
            <strong>{item.name}</strong>
            <span>{item.count} 笔 / {money(item.amount)}</span>
          </article>
        ))}
      </div>
    </div>
  );
}

function buildStatementCsv(result: StatementAnalysisResult): string {
  const rows: Array<Array<string | number | null | undefined>> = [
    ["文件名", result.fileName],
    ["客户名称", result.customerName],
    ["解析来源", result.source],
    ["识别流水条数", result.summary.transactionCount],
    ["收入合计", result.summary.incomeTotal],
    ["支出合计", result.summary.outcomeTotal],
    ["净现金流", result.summary.netCashFlow],
    [],
    ["分析结论"],
    ...result.conclusions.map((item) => [item]),
    [],
    ["主要交易对手", "交易金额", "交易笔数"],
    ...result.summary.topCounterparties.map((item) => [item.name, item.amount, item.count]),
    [],
    ["交易日期", "收支方向", "交易金额", "账户余额", "对方户名", "摘要", "渠道"],
    ...result.transactions.map((txn) => [
      txn.date,
      txn.direction === "in" ? "收入" : "支出",
      txn.amount,
      txn.balanceAfter ?? "",
      txn.counterparty,
      txn.summary,
      txn.channel ?? "",
    ]),
  ];
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`;
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function InsightCard({ label, value, body }: { label: string; value: string; body: string }) {
  return (
    <article className="insight-card">
      <p>{label}</p>
      <h3>{value}</h3>
      <span>{body}</span>
    </article>
  );
}

function WorkbenchTabs({ activeTab, onSelectTab }: { activeTab: WorkbenchTab; onSelectTab: (tab: WorkbenchTab) => void }) {
  const tabs: Array<{ id: WorkbenchTab; label: string }> = [
    { id: "evidence", label: "证据核验" },
    { id: "plan", label: "产品方案" },
    { id: "battle", label: "办理作战卡" },
    { id: "value", label: "价值闭环" },
  ];
  return (
    <div className="tab-strip" id="workspace">
      {tabs.map((tab) => (
        <button className={tab.id === activeTab ? "is-active" : ""} key={tab.id} onClick={() => onSelectTab(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function WorkbenchBody({
  activeTab,
  activeStep,
  analysis,
  branch,
  dataset,
  statementResult,
  asrResult,
  onAskAssistant,
}: {
  activeTab: WorkbenchTab;
  activeStep: OntologyStep;
  analysis: CustomerAnalysis;
  branch: BranchAnalysis;
  dataset: SettlementDataset;
  statementResult?: StatementAnalysisResult;
  asrResult?: AsrTranscriptionResult;
  onAskAssistant: (question: string) => void;
}) {
  const [animKey, setAnimKey] = useState(activeTab);
  const [animClass, setAnimClass] = useState("");
  const prevTabRef = useRef(activeTab);
  const tabOrder: WorkbenchTab[] = ["evidence", "plan", "battle", "value"];

  useEffect(() => {
    const direction = tabOrder.indexOf(activeTab) >= tabOrder.indexOf(prevTabRef.current) ? "slide-in-left" : "slide-in-right";
    setAnimClass(direction);
    setAnimKey(activeTab);
    prevTabRef.current = activeTab;
    const timer = setTimeout(() => setAnimClass(""), 260);
    return () => clearTimeout(timer);
  }, [activeTab]);

  return (
    <div className={`workspace-transition ${animClass}`} key={animKey}>
      {activeTab === "evidence" && activeStep.id === "customer" && <CustomerWorkspace analysis={analysis} dataset={dataset} />}
      {activeTab === "evidence" && activeStep.id === "need" && <NeedWorkspace analysis={analysis} statementResult={statementResult} asrResult={asrResult} />}
      {activeTab === "plan" && activeStep.id === "usage" && <UsageWorkspace analysis={analysis} onAskAssistant={onAskAssistant} />}
      {activeTab === "plan" && activeStep.id !== "usage" && <PlanWorkspace analysis={analysis} onAskAssistant={onAskAssistant} />}
      {activeTab === "battle" && <BattleWorkspace analysis={analysis} onAskAssistant={onAskAssistant} />}
      {activeTab === "value" && <ValueWorkspace analysis={analysis} branch={branch} onAskAssistant={onAskAssistant} />}
      {activeTab === "evidence" && activeStep.id === "scenario" && <ScenarioWorkspace analysis={analysis} asrResult={asrResult} />}
    </div>
  );
}

function CustomerWorkspace({
  analysis,
  dataset,
}: {
  analysis: CustomerAnalysis;
  dataset: SettlementDataset;
}) {
  const customerId = analysis.customer.customerId;
  const relations = dataset.customerRelations.filter((item) => item.customerId === customerId);
  const snapshots = dataset.balanceSnapshots.filter((item) => item.customerId === customerId);
  const dataSources = [
    { label: "账户档案", value: analysis.accounts.length, detail: "账户名称、类型与余额口径", ready: analysis.accounts.length > 0 },
    { label: "交易流水", value: analysis.transactions.length, detail: "近 90 日行内交易记录", ready: analysis.transactions.length > 0 },
    { label: "产品记录", value: analysis.usages.length, detail: "签约、激活与使用状态", ready: analysis.usages.length > 0 },
    { label: "余额快照", value: snapshots.length, detail: "期末余额与变化轨迹", ready: snapshots.length > 0 },
  ];
  const readyCount = dataSources.filter((source) => source.ready).length;

  return (
    <section className="workspace-card customer-foundation-workspace">
      <header className="workspace-head customer-workspace-head">
        <div>
          <p className="workspace-kicker"><span />主体与数据核验</p>
          <h3>客户底座已建立</h3>
        </div>
        <div className="customer-readiness-score">
          <strong>{readyCount}<small> / {dataSources.length}</small></strong>
          <span>类数据已就绪</span>
        </div>
      </header>

      <div className="customer-identity-layout">
        <section className="customer-record-panel">
          <div className="customer-section-title"><span>01</span><div><strong>客户主体档案</strong><p>来自客户与责任归属主数据</p></div></div>
          <dl className="customer-record-grid">
            <div><dt>客户名称</dt><dd>{analysis.customer.customerName}</dd></div>
            <div><dt>客户号</dt><dd>{analysis.customer.customerId}</dd></div>
            <div><dt>行业</dt><dd>{analysis.customer.industry}</dd></div>
            <div><dt>客户层级</dt><dd>{analysis.customer.customerTier}</dd></div>
            <div><dt>开户支行</dt><dd>{analysis.customer.branchName}</dd></div>
            <div><dt>客户经理</dt><dd>{analysis.customer.managerName}</dd></div>
          </dl>
        </section>

        <section className="customer-account-panel">
          <div className="customer-section-title"><span>02</span><div><strong>账户清单</strong><p>展示账户事实，不在此处解释资金需求</p></div></div>
          <div className="customer-account-list">
            {analysis.accounts.map((account) => (
              <article key={account.accountId}>
                <i />
                <div><strong>{account.accountName}</strong><span>{account.accountId} · {account.accountType}</span></div>
                <dl><dt>当前余额</dt><dd>{money(account.balance)}</dd></dl>
                <dl><dt>90 日均额</dt><dd>{money(account.avgBalance90d)}</dd></dl>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="customer-support-layout">
        <section className="customer-relation-panel">
          <div className="customer-section-title"><span>03</span><div><strong>主体关系</strong><p>核对控制、管理与关联主体</p></div></div>
          <div className="customer-relation-list">
            {relations.length ? relations.slice(0, 4).map((relation) => (
              <article key={relation.relationId}>
                <span>{relation.roleName.slice(0, 1)}</span>
                <div><strong>{relation.relatedName}</strong><p>{relation.roleName} · {percent(relation.relationStrength)} 关系强度</p></div>
              </article>
            )) : <p className="customer-empty-copy">暂无关联主体记录，建议后续访谈补充。</p>}
          </div>
        </section>

        <section className="customer-readiness-panel">
          <div className="customer-section-title"><span>04</span><div><strong>数据就绪度</strong><p>明确后续分析可以使用哪些数据</p></div></div>
          <div className="customer-readiness-list">
            {dataSources.map((source) => (
              <article key={source.label} className={source.ready ? "is-ready" : "is-missing"}>
                <i>{source.ready ? "✓" : "!"}</i>
                <div><strong>{source.label}</strong><p>{source.detail}</p></div>
                <em>{source.value} 条</em>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="customer-boundary-note">
        <span>下一环节</span>
        <strong>资金需求将使用本页确认的数据底座，并结合流水影像与客户访谈形成多源研判。</strong>
      </div>
    </section>
  );
}

function NeedWorkspace({
  analysis,
  statementResult,
  asrResult,
}: {
  analysis: CustomerAnalysis;
  statementResult?: StatementAnalysisResult;
  asrResult?: AsrTranscriptionResult;
}) {
  const primaryNeed = analysis.needs[0];
  const sourceCount = 1 + Number(Boolean(statementResult)) + Number(Boolean(asrResult));
  const interviewInsight = asrResult?.insight;
  const statementSource = statementResult?.source === "textin_xparse_extract_v3" ? "TextIn 双接口" : "本地演示解析";
  const externalSourceCount = sourceCount - 1;
  const fusionState = externalSourceCount === 0 ? "baseline" : externalSourceCount === 1 ? "partial" : "complete";
  const fusionLabel = externalSourceCount === 0 ? "仅行内初判" : externalSourceCount === 1 ? "已完成一项工具分析" : "两项工具分析完成";
  const sourceDescription = externalSourceCount === 0
    ? "当前结论仅由预置的账户与行内流水规则生成；流水影像和访谈录音尚未参与分析。"
    : externalSourceCount === 1
      ? `当前保留行内规则基线，并在本页显示${statementResult ? "流水影像" : "访谈录音"}分析结果；另一项工具尚未分析。`
      : "行内规则、流水影像与访谈录音结果均已在本页展示；右侧按来源列出摘要，等待人工综合复核。";
  const statementLead = statementResult
    ? statementResult.summary.netCashFlow < 0
      ? `本次影像显示净流出 ${money(Math.abs(statementResult.summary.netCashFlow))}，客户需要进一步核实短期资金缺口、用款时点和可承受波动。`
      : `本次影像显示净流入 ${money(statementResult.summary.netCashFlow)}，客户需要进一步确认资金留存周期与未来用款安排。`
    : undefined;
  const statementCounterparties = statementResult?.summary.topCounterparties.slice(0, 3).map((item) => item.name).join("、");
  const toolConclusionTitle = externalSourceCount === 0
    ? "完成上方分析后，在这里形成补充业务结论"
    : externalSourceCount === 1
      ? "已形成 1 项工具结论，另一项待补充"
      : "两项工具结论已形成，可与行内初判对照";

  return (
    <section className="workspace-card need-workspace">
      <header className="workspace-head need-workspace-head">
        <div>
          <p className="workspace-kicker">
            <span />多源资金需求研判
            <em className={`need-fusion-status is-${fusionState}`}>{fusionLabel}</em>
          </p>
          <h3>{primaryNeed.needType}</h3>
          <p>{sourceDescription}</p>
        </div>
        <div className="need-source-readiness">
          <strong>{sourceCount}<small> / 3</small></strong>
          <span>证据源已就绪</span>
        </div>
      </header>

      <div className="need-analysis-layout">
        <section className="need-conclusion-panel">
          <div className="need-section-heading">
            <div><p className="eyebrow">行内规则初判</p><h4>基于预置账户与行内流水形成的基线结论</h4></div>
            <span>{externalSourceCount ? "基线保留 · 对照工具结果" : "不含影像与录音"}</span>
          </div>
          <div className="need-finding-list">
            {analysis.needs.slice(0, 3).map((need, index) => (
              <article className={index === 0 ? "is-primary" : ""} key={need.needId}>
                <span>0{index + 1}</span>
                <div><strong>{need.needType}</strong><p>{need.explanation}</p></div>
                <em>规则匹配 {percent(need.confidence)}</em>
              </article>
            ))}
          </div>
          <footer className="need-baseline-metrics">
            <div><span>90 日均额</span><strong>{money(analysis.features.avgBalance90d)}</strong></div>
            <div><span>当前余额</span><strong>{money(analysis.features.currentBalance)}</strong></div>
            <div><span>规则证据流水</span><strong>{primaryNeed.evidenceTxnIds.length} 条</strong></div>
          </footer>
        </section>

        <section className="need-source-panel">
          <div className="need-section-heading">
            <div><p className="eyebrow">工具补充结论</p><h4>{toolConclusionTitle}</h4></div>
            <span>{externalSourceCount} / 2 已完成</span>
          </div>
          <div className="need-tool-result-list">
            <article className={`need-tool-result-card is-statement ${statementResult ? "has-result" : "is-empty"}`}>
              <header>
                <div><i>01</i><span><strong>流水影像结论</strong><small>{statementResult ? statementSource : "等待分析"}</small></span></div>
                {statementResult && <em>{statementResult.summary.transactionCount} 条流水</em>}
              </header>
              {statementResult ? (
                <>
                  <h5>{statementLead ?? "已完成流水结构化分析，建议结合原始影像人工复核。"}</h5>
                  <div className="need-result-metrics">
                    <div><span>收入</span><strong>{money(statementResult.summary.incomeTotal)}</strong></div>
                    <div><span>支出</span><strong>{money(statementResult.summary.outcomeTotal)}</strong></div>
                    <div><span>净现金流</span><strong className={statementResult.summary.netCashFlow >= 0 ? "is-positive" : "is-negative"}>{statementResult.summary.netCashFlow >= 0 ? "+" : "-"}{money(Math.abs(statementResult.summary.netCashFlow))}</strong></div>
                  </div>
                  {statementCounterparties && <p>主要交易对手集中在：{statementCounterparties}。</p>}
                </>
              ) : (
                <div className="need-result-empty">
                  <strong>等待流水影像分析</strong>
                  <p>完成后将展示收支结构、资金压力、交易集中度和业务判断。</p>
                </div>
              )}
            </article>

            <article className={`need-tool-result-card is-interview ${asrResult ? "has-result" : "is-empty"}`}>
              <header>
                <div><i>02</i><span><strong>访谈录音结论</strong><small>{interviewInsight ? "GLM-5.2 业务凝练" : "等待分析"}</small></span></div>
                {asrResult?.durationSeconds && <em>{asrResult.durationSeconds} 秒</em>}
              </header>
              {asrResult && interviewInsight ? (
                <>
                  <h5>{interviewInsight.needType}</h5>
                  <blockquote>“{interviewInsight.evidenceQuote}”</blockquote>
                  <footer>
                    <div className="need-signal-chips">
                      <span>客户原话凝练</span>
                      <span>{percent(interviewInsight.confidence)} 置信度</span>
                    </div>
                    <p>{interviewInsight.summary} 下一步核实：{interviewInsight.nextQuestion}</p>
                  </footer>
                </>
              ) : (
                <div className="need-result-empty">
                  <strong>等待访谈录音分析</strong>
                  <p>完成后将展示客户原话摘要、需求信号和建议核实的问题。</p>
                </div>
              )}
            </article>
          </div>
        </section>
      </div>

      <div className="need-boundary-note">
        <span>下一环节</span>
        <strong>结算场景将基于本页资金需求，解释“这些资金活动发生在哪类经营活动中”。</strong>
      </div>
    </section>
  );
}

function ScenarioWorkspace({ analysis, asrResult }: { analysis: CustomerAnalysis; asrResult?: AsrTranscriptionResult }) {
  const interviewInsight = asrResult?.insight;
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(analysis.scenarios[0].scenarioId);
  const [sortField, setSortField] = useState<"date" | "amount">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterDir, setFilterDir] = useState<"all" | "in" | "out">("all");
  const [showCount, setShowCount] = useState(10);
  const displayedScenarioCount = Math.min(analysis.scenarios.length, 2) + (interviewInsight ? 1 : 0);
  const isInterviewEvidence = selectedEvidenceId === "interview" && Boolean(interviewInsight);
  const scenario = analysis.scenarios.find((item) => item.scenarioId === selectedEvidenceId) ?? analysis.scenarios[0];

  useEffect(() => {
    setSelectedEvidenceId(analysis.scenarios[0].scenarioId);
  }, [analysis.customer.customerId]);

  useEffect(() => {
    if (interviewInsight) setSelectedEvidenceId("interview");
  }, [interviewInsight]);

  const filtered = scenario.evidenceRows.filter((txn) => filterDir === "all" || txn.direction === filterDir);
  const sorted = [...filtered].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "amount") return mul * (a.amount - b.amount);
    return mul * a.txnDate.localeCompare(b.txnDate);
  });
  const visible = sorted.slice(0, showCount);
  const evidenceConfidence = isInterviewEvidence && interviewInsight ? interviewInsight.confidence : scenario.confidence;
  const confidenceColor = evidenceConfidence >= 0.85 ? "var(--green)" : evidenceConfidence >= 0.7 ? "var(--amber)" : "var(--red)";
  const circumference = 2 * Math.PI * 28;
  const dashOffset = circumference * (1 - evidenceConfidence);

  const verifiedCount = scenario.evidenceRows.filter((t) => t.verificationStatus === "verified").length;
  const pendingCount = scenario.evidenceRows.filter((t) => t.verificationStatus === "pending").length;
  const suspiciousCount = scenario.evidenceRows.filter((t) => t.verificationStatus === "suspicious").length;

  function statusLabel(status: string) {
    if (status === "verified") return { text: "已核验", className: "is-verified" };
    if (status === "suspicious") return { text: "存疑", className: "is-suspicious" };
    return { text: "待核实", className: "is-pending" };
  }

  return (
    <section className="workspace-card evidence-workspace">
      <div className="scenario-evidence-canvas" aria-label="结算场景证据画布">
        <div className="scenario-canvas-heading">
          <div><span>多源场景证据</span><strong>承接已确认需求，评估对应经营活动</strong></div>
          <em>{displayedScenarioCount} 个场景</em>
        </div>
        <div className="scenario-source-list">
          {analysis.scenarios.slice(0, 2).map((item) => (
            <button
              type="button"
              key={item.scenarioId}
              className={selectedEvidenceId === item.scenarioId ? "is-active" : ""}
              onClick={() => setSelectedEvidenceId(item.scenarioId)}
            >
              <span><i className="is-ledger" />流水识别</span>
              <strong>{item.scenarioName}</strong>
              <small>{percent(item.confidence)} · {item.evidenceRows.length} 条流水证据</small>
            </button>
          ))}
          {interviewInsight && (
            <button
              type="button"
              className={`is-interview ${isInterviewEvidence ? "is-active" : ""}`}
              onClick={() => setSelectedEvidenceId("interview")}
            >
              <span><i className="is-interview" />访谈新增 <b>NEW</b></span>
              <strong>{interviewInsight.scenarioName}</strong>
              <small>{percent(interviewInsight.confidence)} · 1 段客户原话证据</small>
            </button>
          )}
          {!interviewInsight && (
            <div className="scenario-interview-placeholder">
              <span>＋</span><strong>等待访谈补充场景</strong><small>上传客户录音后自动写入</small>
            </div>
          )}
        </div>
      </div>
      <div className="workspace-head">
        <div>
          <p className="workspace-kicker"><span />{isInterviewEvidence ? "客户原话证据" : "场景证据核验 · 近 90 日"}</p>
          <h3>{isInterviewEvidence && interviewInsight ? interviewInsight.scenarioName : scenario.scenarioName}</h3>
          <p>{isInterviewEvidence && interviewInsight ? interviewInsight.scenarioRationale || `客户原话所描述的资金安排方式与${interviewInsight.scenarioName}相匹配，仍需结合交易核验。` : scenario.evidence}</p>
        </div>
        <svg className="confidence-ring" width="68" height="68" viewBox="0 0 68 68">
          <circle cx="34" cy="34" r="28" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="5" />
          <circle cx="34" cy="34" r="28" fill="none" stroke={confidenceColor} strokeWidth="5" strokeDasharray={circumference} strokeDashoffset={dashOffset} strokeLinecap="round" transform="rotate(-90 34 34)" />
          <text x="34" y="38" textAnchor="middle" fontSize="14" fontWeight="800" fill={confidenceColor}>{percent(evidenceConfidence)}</text>
        </svg>
      </div>
      <div className="verification-summary">
        {isInterviewEvidence ? (
          <>
            <span className="verification-badge is-verified">客户原话 1 段</span>
            <span className="verification-badge is-pending">GLM 业务凝练 1 项</span>
            <span className="verification-badge is-suspicious">待交叉核验 1 项</span>
          </>
        ) : (
          <>
            <span className="verification-badge is-verified">已核验 {verifiedCount} 条</span>
            <span className="verification-badge is-pending">待核实 {pendingCount} 条</span>
            <span className="verification-badge is-suspicious">存疑 {suspiciousCount} 条</span>
          </>
        )}
      </div>
      {isInterviewEvidence && interviewInsight ? (
        <div className="interview-evidence-detail">
          <article className="interview-quote-card">
            <span>客户原话</span>
            <blockquote>“{interviewInsight.evidenceQuote}”</blockquote>
            <small>来源：客户访谈录音 · Fun-ASR 原文转写</small>
          </article>
          <div className="interview-insight-grid">
            <article><span>场景触发需求</span><strong>{interviewInsight.needType}</strong><p>该需求已在上一环节确认，本页只判断其对应的经营活动。</p></article>
            <article><span>下一步核实</span><strong>客户经理追问</strong><p>{interviewInsight.nextQuestion}</p></article>
            <article><span>场景判断依据</span><strong>{interviewInsight.scenarioName}</strong><p>{interviewInsight.scenarioRationale || "访谈线索需与交易流水进一步交叉核验。"}</p></article>
          </div>
        </div>
      ) : (
        <>
          <div className="evidence-toolbar">
            <button className={sortField === "date" ? "is-active" : ""} onClick={() => { if (sortField === "date") setSortDir(sortDir === "asc" ? "desc" : "asc"); else { setSortField("date"); setSortDir("desc"); } }}>按日期{sortField === "date" ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
            <button className={sortField === "amount" ? "is-active" : ""} onClick={() => { if (sortField === "amount") setSortDir(sortDir === "asc" ? "desc" : "asc"); else { setSortField("amount"); setSortDir("desc"); } }}>按金额{sortField === "amount" ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
            <span className="evidence-toolbar-sep" />
            <button className={filterDir === "all" ? "is-active" : ""} onClick={() => setFilterDir("all")}>全部</button>
            <button className={filterDir === "in" ? "is-active" : ""} onClick={() => setFilterDir("in")}>↑ 收入</button>
            <button className={filterDir === "out" ? "is-active" : ""} onClick={() => setFilterDir("out")}>↓ 支出</button>
          </div>
          <div className="transaction-table">
            {visible.map((txn) => {
              const status = statusLabel(txn.verificationStatus ?? "pending");
              return (
                <article key={txn.txnId}>
                  <span className={txn.direction === "in" ? "income" : "outcome"}>{txn.direction === "in" ? "↑ 收入" : "↓ 支出"}</span>
                  <div>
                    <strong>{txn.counterpartyName}</strong>
                    <p>{txn.txnDate} / {txn.channel} / {txn.summary}</p>
                  </div>
                  <em className={txn.direction === "in" ? "income-amount" : "outcome-amount"}>{money(txn.amount)}</em>
                  <span className={`verification-tag ${status.className}`}>{status.text}</span>
                </article>
              );
            })}
          </div>
          {sorted.length > showCount && (
            <button className="load-more-button" onClick={() => setShowCount(showCount + 10)}>查看更多（{sorted.length - showCount} 条）</button>
          )}
        </>
      )}
    </section>
  );
}

function PlanWorkspace({ analysis, onAskAssistant }: { analysis: CustomerAnalysis; onAskAssistant: (question: string) => void }) {
  const bundle = analysis.bundles[0];
  const signedCount = bundle.products.filter((product) => analysis.usages.some((usage) => usage.productId === product.productId && usage.signed)).length;
  const activatedCount = bundle.products.filter((product) => analysis.usages.some((usage) => usage.productId === product.productId && usage.activated)).length;
  return (
    <section className="workspace-card plan-workspace product-decision-workspace">
      <div className="workspace-head product-decision-head">
        <div>
          <p className="workspace-kicker"><span />组合决策台 · {bundle.scenarioName}</p>
          <h3>{bundle.bundleName}</h3>
          <p>{bundle.fitReason}</p>
        </div>
        <button className="primary-button" onClick={() => onAskAssistant("为什么是这个产品组合？")}>解释组合</button>
      </div>
      <div className="product-plan-summary" aria-label="产品组合概览">
        <div>
          <span>组合产品</span>
          <strong>{bundle.products.length}<small>项</small></strong>
          <p>覆盖支付、系统连接与对账链路</p>
        </div>
        <div>
          <span>签约进度</span>
          <strong>{signedCount}<small> / {bundle.products.length}</small></strong>
          <p>以客户实际产品使用记录为准</p>
        </div>
        <div className={bundle.missingProducts.length ? "needs-attention" : "is-complete"}>
          <span>待补齐</span>
          <strong>{bundle.missingProducts.length}<small>项</small></strong>
          <p>{bundle.missingProducts.length ? "优先推进关键连接能力" : "组合覆盖完整，关注使用深度"}</p>
        </div>
      </div>
      <div className="product-grid product-portfolio">
        {bundle.products.map((product, index) => {
          const usage = analysis.usages.find((u) => u.productId === product.productId);
          const isSigned = usage?.signed ?? false;
          const isActivated = usage?.activated ?? false;
          const statusClass = isActivated ? "is-signed" : isSigned ? "is-pending" : "is-missing";
          const statusLabel = isActivated ? "已激活" : isSigned ? "已签约" : "待办理";
          return (
            <article key={product.productId} className={`product-card ${statusClass}`}>
              <header>
                <span className="product-sequence">0{index + 1}</span>
                <span className="product-badge">{statusLabel}</span>
              </header>
              <div className="product-title-row">
                <strong>{product.productName}</strong>
                <span>{product.productType}</span>
              </div>
              <p className="product-value">{product.valuePoint}</p>
              <footer>
                <span>办理要点</span>
                <small>{product.requiredMaterials}</small>
              </footer>
            </article>
          );
        })}
      </div>
      <div className={`product-followup-grid ${bundle.missingProducts.length ? "" : "has-no-gap"}`}>
        {bundle.missingProducts.length > 0 && (
          <div className="product-gap-section">
            <div className="product-gap-heading">
              <div><p className="eyebrow">关键缺口</p><strong>补齐组合中的断点能力</strong></div>
              <span>{bundle.missingProducts.length} 项待推进</span>
            </div>
            <div className="product-gap-grid">
              {bundle.missingProducts.map((product) => (
                <article key={product.productId} className="product-card is-gap">
                  <div><span className="product-badge">缺口</span><strong>{product.productName}</strong></div>
                  <span>{product.productType}</span>
                  <p>{product.valuePoint}</p>
                </article>
              ))}
            </div>
          </div>
        )}
        <div className="competitor-alert">
          <div className="competitor-heading"><p className="eyebrow">经营关注</p><span>从配置走向经营</span></div>
          <div className="competitor-cards">
            <div className="competitor-card">
              <span className="competitor-index">01</span>
              <strong>产品缺口防流失</strong>
              <p>当前仍有 {bundle.missingProducts.length} 项推荐产品未覆盖，建议优先补齐高频结算链路，减少客户转向外部替代方案。</p>
            </div>
            <div className="competitor-card">
              <span className="competitor-index">02</span>
              <strong>差异化优势</strong>
              <p>我行在{bundle.bundleName.includes("银企直联") ? "银企直联" : "企业网银"}方面具有费率优势和本地化服务团队，可重点强调。</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function UsageWorkspace({ analysis, onAskAssistant }: { analysis: CustomerAnalysis; onAskAssistant: (question: string) => void }) {
  const bundle = analysis.bundles[0];
  const signedCount = bundle.products.filter((product) => analysis.usages.some((usage) => usage.productId === product.productId && usage.signed)).length;
  const activatedCount = bundle.products.filter((product) => analysis.usages.some((usage) => usage.productId === product.productId && usage.activated)).length;
  const totalTxnCount = analysis.usages.reduce((total, usage) => total + usage.txnCount90d, 0);
  const totalTxnAmount = analysis.usages.reduce((total, usage) => total + usage.txnAmount90d, 0);

  return (
    <section className="workspace-card usage-workspace">
      <div className="workspace-head usage-workspace-head">
        <div>
          <p className="workspace-kicker"><span />产品使用诊断 · 近 90 日</p>
          <h3>覆盖不等于使用，定位签约后的真实活跃度</h3>
          <p>同时检查场景覆盖、产品签约、激活状态与交易承接，识别需要补签、激活或提频的具体环节。</p>
        </div>
        <button className="primary-button" onClick={() => onAskAssistant("如何解读当前产品使用诊断？")}>解读诊断</button>
      </div>

      <div className="usage-summary-grid" aria-label="使用诊断概览">
        <article><span>推荐产品</span><strong>{bundle.products.length}<small> 项</small></strong><p>{bundle.scenarioName}</p></article>
        <article><span>已签约</span><strong>{signedCount}<small> / {bundle.products.length}</small></strong><p>其中 {activatedCount} 项已激活</p></article>
        <article className={bundle.missingProducts.length ? "needs-attention" : "is-complete"}><span>覆盖缺口</span><strong>{bundle.missingProducts.length}<small> 项</small></strong><p>{bundle.missingProducts.map((product) => product.productName).join("、") || "暂无产品缺口"}</p></article>
        <article><span>90 日交易承接</span><strong>{totalTxnCount}<small> 笔</small></strong><p>累计 {money(totalTxnAmount)}</p></article>
      </div>

      <div className="usage-diagnostic-layout">
        <section className="coverage-matrix">
          <div className="diagnostic-section-head">
            <div><p className="eyebrow">场景覆盖</p><h4>组合覆盖矩阵</h4></div>
            <span>{analysis.coverage.length} 个场景</span>
          </div>
          <div className="coverage-list">
            {analysis.coverage.map((coverage) => {
              const ratio = coverage.totalCount ? coverage.signedCount / coverage.totalCount : 0;
              const statusClass = coverage.status === "已覆盖" ? "is-covered" : coverage.status === "部分覆盖" ? "is-partial" : "is-uncovered";
              return (
                <article className={statusClass} key={coverage.scenarioName}>
                  <header><strong>{coverage.scenarioName}</strong><span>{coverage.status}</span></header>
                  <div className="coverage-progress" aria-label={`已签约 ${coverage.signedCount} / ${coverage.totalCount}`}><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
                  <div className="coverage-meta">
                    <span>已签约 {coverage.signedCount} / {coverage.totalCount}</span>
                    <span>{coverage.description}</span>
                    <span className="coverage-gap">{coverage.missingProducts.length > 0 ? `缺口：${coverage.missingProducts.join("、")}` : "缺口：无"}</span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="product-usage-panel">
          <div className="diagnostic-section-head">
            <div><p className="eyebrow">产品明细</p><h4>签约与活跃状态</h4></div>
            <span>逐项核验</span>
          </div>
          <div className="product-usage-list">
            {bundle.products.map((product) => {
              const usage = analysis.usages.find((item) => item.productId === product.productId);
              const statusClass = usage?.activated ? (usage.usageStatus.includes("低频") ? "is-low" : "is-healthy") : usage?.signed ? "is-inactive" : "is-gap";
              const statusLabel = usage?.activated ? usage.usageStatus : usage?.signed ? "已签约未激活" : "未见签约";
              return (
                <article className={statusClass} key={product.productId}>
                  <div className="usage-product-title"><i /><div><strong>{product.productName}</strong><span>{product.productType}</span></div></div>
                  <span className="usage-status">{statusLabel}</span>
                  <dl>
                    <div><dt>90 日笔数</dt><dd>{usage ? `${usage.txnCount90d} 笔` : "--"}</dd></div>
                    <div><dt>交易金额</dt><dd>{usage ? money(usage.txnAmount90d) : "--"}</dd></div>
                    <div><dt>最近使用</dt><dd>{usage?.lastUsedDate || "暂无记录"}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <div className="usage-action-bar">
        <div><span>下一步经营动作</span><strong>{analysis.value.nextAction}</strong></div>
        <button type="button" onClick={() => onAskAssistant("根据使用诊断生成下一步经营动作")}>生成跟进建议</button>
      </div>
    </section>
  );
}

function BattleWorkspace({ analysis, onAskAssistant }: { analysis: CustomerAnalysis; onAskAssistant: (question: string) => void }) {
  const bundle = analysis.bundles[0];
  const materials = unique(bundle.products.flatMap((item) => item.requiredMaterials.split("、")));
  const storageKey = `battle-materials-${analysis.customer.customerId}`;
  const [checkedMaterials, setCheckedMaterials] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      setCheckedMaterials(saved ? new Set(JSON.parse(saved)) : new Set());
    } catch {
      setCheckedMaterials(new Set());
    }
  }, [storageKey]);

  function toggleMaterial(mat: string) {
    setCheckedMaterials((prev) => {
      const next = new Set(prev);
      if (next.has(mat)) next.delete(mat); else next.add(mat);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {

      }
      return next;
    });
  }

  return (
    <section className="workspace-card battle-workspace">
      <div className="workspace-head">
        <div>
          <p className="workspace-kicker"><span />办理行动台 · 客户经理</p>
          <h3>客户经营推进方案</h3>
          <p>{bundle.verifyQuestion}</p>
        </div>
        <button className="primary-button" onClick={() => onAskAssistant("生成客户经理沟通话术")}>生成话术</button>
      </div>
      <div className="battle-sections">
        <div className="battle-section battle-verify">
          <div className="battle-section-icon">?</div>
          <div>
            <h4>核实问题</h4>
            <p>{bundle.verifyQuestion}</p>
          </div>
        </div>
        <div className="battle-section battle-materials">
          <div className="battle-section-icon">☐</div>
          <div>
            <h4>材料清单</h4>
            <ul className="material-list">
              {materials.slice(0, 6).map((mat) => (
                <li key={mat} className={checkedMaterials.has(mat) ? "is-checked" : ""}>
                  <label><input type="checkbox" checked={checkedMaterials.has(mat)} onChange={() => toggleMaterial(mat)} /> {mat}</label>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="battle-section battle-script">
          <div className="battle-section-icon">💬</div>
          <div>
            <h4>沟通话术</h4>
            <p>我们不是单独推荐产品，而是根据贵司流水里反复出现的{bundle.scenarioName}，设计一套提升效率和对账质量的结算服务方案。</p>
          </div>
        </div>
        <div className="battle-section battle-action">
          <div className="battle-section-icon">→</div>
          <div>
            <h4>跟进动作</h4>
            <p>{analysis.value.nextAction}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ValueWorkspace({ analysis, branch, onAskAssistant }: { analysis: CustomerAnalysis; branch: BranchAnalysis; onAskAssistant: (question: string) => void }) {
  const maxVal = Math.max(analysis.value.estimatedDepositIncrease, analysis.value.estimatedTxnIncrease, branch.totalDepositIncrease, 1);
  const barHeight = (val: number) => Math.max((val / maxVal) * 120, 8);
  const milestones = [
    { label: "需求核验", days: 3, desc: "确认客户结算痛点" },
    { label: "材料准备", days: 7, desc: "收集签约材料" },
    { label: "产品开通", days: 14, desc: "完成系统配置" },
    { label: "首月跟踪", days: 30, desc: "验证使用活跃度" },
    { label: "价值达成", days: 90, desc: "存款沉淀提升" },
  ];
  return (
    <section className="workspace-card value-workspace">
      <div className="workspace-head">
        <div>
          <p className="workspace-kicker"><span />价值闭环 · 90 日路径</p>
          <h3>价值结果与支行报告</h3>
          <p>{buildReportSummary(analysis)}</p>
        </div>
        <button className="primary-button" onClick={() => onAskAssistant("生成支行汇报摘要")}>生成摘要</button>
      </div>
      <div className="value-chart">
        <div className="value-bar-group">
          <div className="value-bar is-deposit" style={{ height: `${barHeight(analysis.value.estimatedDepositIncrease)}px` }} />
          <span className="value-bar-label">存款提升</span>
          <span className="value-bar-value">{money(analysis.value.estimatedDepositIncrease)}</span>
        </div>
        <div className="value-bar-group">
          <div className="value-bar is-txn" style={{ height: `${barHeight(analysis.value.estimatedTxnIncrease)}px` }} />
          <span className="value-bar-label">交易提升</span>
          <span className="value-bar-value">{money(analysis.value.estimatedTxnIncrease)}</span>
        </div>
        <div className="value-bar-group">
          <div className="value-bar is-branch" style={{ height: `${barHeight(branch.totalDepositIncrease)}px` }} />
          <span className="value-bar-label">支行总沉淀</span>
          <span className="value-bar-value">{money(branch.totalDepositIncrease)}</span>
        </div>
      </div>
      <div className="value-timeline">
        <p className="eyebrow">预计达成路径</p>
        <div className="timeline-track">
          {milestones.map((item, index) => (
            <div className="timeline-node" key={item.label}>
              <span className="timeline-dot">{index + 1}</span>
              <strong>{item.label}</strong>
              <span className="timeline-days">{item.days} 天</span>
              <span className="timeline-desc">{item.desc}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="value-grid">
        <Metric label="预计存款提升" value={<>{money(analysis.value.estimatedDepositIncrease)} <span className="trend-up">↑</span></>} />
        <Metric label="预计交易提升" value={<>{money(analysis.value.estimatedTxnIncrease)} <span className="trend-up">↑</span></>} />
        <Metric label="支行总沉淀" value={money(branch.totalDepositIncrease)} />
        <Metric label="责任人" value={analysis.value.actionOwner} />
      </div>
    </section>
  );
}

function ActionPanel({
  analysis,
  activeStep,
  messages,
  onAskAssistant,
  onClose,
  onExpand,
  onReset,
  onInputFocusChange,
  eyebrow = "业务助手",
  title = "可追问的业务助手",
  variant = "embedded",
}: {
  analysis: CustomerAnalysis;
  activeStep: OntologyStep;
  messages: AssistantMessage[];
  onAskAssistant: (question: string) => void;
  onClose?: () => void;
  onExpand?: () => void;
  onReset: () => void;
  onInputFocusChange?: (focused: boolean) => void;
  eyebrow?: string;
  title?: string;
  variant?: "embedded" | "dialog";
}) {
  const [draft, setDraft] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [usedPrompts, setUsedPrompts] = useState<Set<string>>(new Set());
  const chatLogRef = useRef<HTMLDivElement>(null);
  const activeInsight = buildNodeInsight(analysis, activeStep.id);
  const visibleMessages = messages.length ? messages : [{ role: "assistant" as const, text: activeInsight.text }];

  useEffect(() => {
    if (chatLogRef.current) chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    setUsedPrompts(new Set());
  }, [activeStep.id]);

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAskAssistant(draft);
    setDraft("");
  }

  function handleQuickPrompt(prompt: string) {
    onAskAssistant(prompt);
    setUsedPrompts((prev) => new Set(prev).add(prompt));
  }

  function handleReset() {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    setConfirmReset(false);
    onReset();
  }

  return (
    <aside className={`action-panel action-panel-${variant}`} id={variant === "embedded" ? "assistant" : undefined}>
      <div className="assistant-head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <div className="assistant-head-actions">
          {onExpand && <button type="button" onClick={onExpand}>放大</button>}
          {onClose && <button type="button" aria-label="关闭 业务助手" onClick={onClose}>×</button>}
        </div>
      </div>
      <div className="assistant-stage-label">
        <span>{ontologySteps.findIndex((item) => item.id === activeStep.id) + 1}</span>
        当前环节 · {activeStep.label}
      </div>
      <div className="quick-prompts">
        {activeInsight.prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            data-stage-question={activeStep.id}
            className={usedPrompts.has(prompt) ? "is-used" : ""}
            onClick={() => handleQuickPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
      <div className="chat-log" ref={chatLogRef}>
        {visibleMessages.map((message, index) => {
          const confidenceColor = message.confidence && message.confidence >= 0.85 ? "var(--green)" : message.confidence && message.confidence >= 0.7 ? "var(--amber)" : "var(--red)";
          return (
            <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
              {message.text || (
                <span className="thinking-dots">
                  <span /><span /><span />
                </span>
              )}
              {message.role === "assistant" && message.text && (
                <div className="message-meta">
                  {message.confidence !== undefined && (
                    <span className="confidence-badge" style={{ color: confidenceColor }}>
                      可信度 {Math.round(message.confidence * 100)}%
                    </span>
                  )}
                  {message.sources && message.sources.length > 0 && (
                    <span className="sources-badge">来源：{message.sources.join("、")}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <form className="chat-form" onSubmit={submitQuestion}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => onInputFocusChange?.(true)}
          onBlur={() => onInputFocusChange?.(false)}
          placeholder="追问当前客户..."
        />
        <button type="submit">发送</button>
      </form>
      <button className="reset-button" onClick={handleReset}>{confirmReset ? "确认清空？" : "清空对话"}</button>
    </aside>
  );
}

const COMPANION_HINTS: Record<OntologyStep["id"], string> = {
  customer: "客户画像已经整理好，点我一起下钻。",
  need: "我发现了资金状态线索，要看看依据吗？",
  scenario: "关键结算场景已定位，可以继续追问证据。",
  product: "产品组合已经匹配好，我来解释推荐理由。",
  process: "办理作战卡已准备，可以问我材料和话术。",
  usage: "我发现了产品覆盖缺口，点我查看诊断。",
  value: "价值测算已经完成，我可以生成汇报摘要。",
};

const XIN_COMPANION_POSITION_KEY = "xin-companion-position-v2";
const XIN_COMPANION_GUTTER = 30;
const LULU_FRAME_WIDTH = 80;
const LULU_FRAME_HEIGHT = 260 / 3;

type LuluAnimationState = "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";

const LULU_ANIMATIONS: Record<LuluAnimationState, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 360] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 180] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 180] },
  waving: { row: 3, durations: [150, 150, 150, 300] },
  jumping: { row: 4, durations: [135, 135, 150, 150, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [160, 160, 160, 160, 160, 280] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [160, 160, 160, 160, 160, 300] },
};

function LuluSprite({ state }: { state: LuluAnimationState }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const animation = LULU_ANIMATIONS[state];
    let currentFrame = 0;
    let timer = 0;
    const advance = () => {
      timer = window.setTimeout(() => {
        currentFrame = (currentFrame + 1) % animation.durations.length;
        setFrame(currentFrame);
        advance();
      }, animation.durations[currentFrame]);
    };
    advance();
    return () => window.clearTimeout(timer);
  }, [state]);

  const animation = LULU_ANIMATIONS[state];
  return (
    <span
      className="lulu-sprite"
      data-pet-state={state}
      style={{
        backgroundImage: `url(${luluSpritesheet})`,
        backgroundPosition: `${-frame * LULU_FRAME_WIDTH}px ${-animation.row * LULU_FRAME_HEIGHT}px`,
      }}
    />
  );
}

function BusinessCompanion({
  analysis,
  activeStep,
  messages,
  isOpen,
  isAnalyzing,
  onToggle,
  onClose,
  onAskAssistant,
  onReset,
}: {
  analysis: CustomerAnalysis;
  activeStep: OntologyStep;
  messages: AssistantMessage[];
  isOpen: boolean;
  isAnalyzing: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAskAssistant: (question: string) => void;
  onReset: () => void;
}) {
  const [position, setPosition] = useState(() => loadCompanionPosition());
  const [hintVisible, setHintVisible] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [hoverReactionSuppressed, setHoverReactionSuppressed] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [petReaction, setPetReaction] = useState<LuluAnimationState | null>(null);
  const [dragDirection, setDragDirection] = useState<"running-left" | "running-right">("running-right");
  const companionRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const isLeftSide = position.x < (typeof window === "undefined" ? 640 : window.innerWidth / 2);
  const isUpperHalf = position.y < (typeof window === "undefined" ? 400 : window.innerHeight / 2);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    if (isOpen || isAnalyzing) return undefined;
    setHintVisible(true);
    const timer = window.setTimeout(() => setHintVisible(false), 5200);
    return () => window.clearTimeout(timer);
  }, [activeStep.id, analysis.customer.customerId, isAnalyzing, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node) || companionRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) setIsInputFocused(false);
  }, [isOpen]);

  useEffect(() => {
    function keepInsideViewport() {
      setPosition((current) => clampCompanionPosition(current));
    }
    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, []);

  useEffect(() => {
    function moveCompanion(event: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(deltaX) + Math.abs(deltaY) > 5) {
        drag.moved = true;
        setIsDragging(true);
        setIsHovering(false);
      }
      if (!drag.moved) return;
      event.preventDefault();
      if (Math.abs(deltaX) > 2) setDragDirection(deltaX < 0 ? "running-left" : "running-right");
      setPosition(clampCompanionPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY }));
    }

    function finishCompanionDrag(event: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setIsDragging(false);
      if (!drag.moved) return;
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      setPosition((current) => {
        const snapped = snapCompanionToEdge(current);
        window.localStorage.setItem(XIN_COMPANION_POSITION_KEY, JSON.stringify(snapped));
        return snapped;
      });
    }

    window.addEventListener("pointermove", moveCompanion, { passive: false });
    window.addEventListener("pointerup", finishCompanionDrag);
    window.addEventListener("pointercancel", finishCompanionDrag);
    return () => {
      window.removeEventListener("pointermove", moveCompanion);
      window.removeEventListener("pointerup", finishCompanionDrag);
      window.removeEventListener("pointercancel", finishCompanionDrag);
    };
  }, []);

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (isDragging) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1);
    const relativeY = clamp((event.clientY - bounds.top) / bounds.height * 2 - 1, -1, 1);
    event.currentTarget.style.setProperty("--lulu-look-x", `${relativeX * 4}px`);
    event.currentTarget.style.setProperty("--lulu-look-y", `${relativeY * 2}px`);
    event.currentTarget.style.setProperty("--lulu-tilt", `${relativeX * 3}deg`);
  }

  function handlePointerLeave(event: PointerEvent<HTMLButtonElement>) {
    setIsHovering(false);
    setHoverReactionSuppressed(false);
    event.currentTarget.style.removeProperty("--lulu-look-x");
    event.currentTarget.style.removeProperty("--lulu-look-y");
    event.currentTarget.style.removeProperty("--lulu-tilt");
  }

  function handleToggle() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setHintVisible(false);
    setHoverReactionSuppressed(true);
    setPetReaction("jumping");
    window.setTimeout(() => setPetReaction(null), 760);
    onToggle();
  }

  const petState: LuluAnimationState = isAnalyzing
    ? "running"
    : isDragging
      ? dragDirection
      : petReaction ?? (isInputFocused ? "waiting" : !isOpen && isHovering && !hoverReactionSuppressed ? "waving" : "idle");

  return (
    <div
      ref={companionRef}
      className={`xin-companion ${isOpen ? "is-open" : ""} ${isAnalyzing ? "is-analyzing" : ""} ${isDragging ? "is-dragging" : ""} ${isLeftSide ? "is-left-side" : "is-right-side"} ${isUpperHalf ? "is-upper-half" : "is-lower-half"}`}
      style={{ "--companion-x": `${position.x}px`, "--companion-y": `${position.y}px` } as CSSProperties}
    >
      {!isOpen && (hintVisible || isAnalyzing) && (
        <div className="xin-companion-hint" role="status">
          <span>{isAnalyzing ? "正在分析" : `当前环节 · ${activeStep.label}`}</span>
          <strong>{isAnalyzing ? "我正在汇聚客户证据，请稍等一下。" : COMPANION_HINTS[activeStep.id]}</strong>
          {!isAnalyzing && <button type="button" aria-label="关闭鑫伴提示" onClick={() => setHintVisible(false)}>×</button>}
        </div>
      )}

      {isOpen && (
        <div className="xin-companion-panel" role="dialog" aria-label="鑫伴业务助手">
          <div className="xin-companion-panel-identity">
            <span><i />鑫伴在线</span>
            <em>{analysis.customer.customerName}</em>
          </div>
          <ActionPanel
            analysis={analysis}
            activeStep={activeStep}
            messages={messages}
            onAskAssistant={onAskAssistant}
            onReset={onReset}
            onInputFocusChange={setIsInputFocused}
            onClose={onClose}
            eyebrow="鑫伴 · 业务精灵"
            title="你的结算业务伙伴"
            variant="dialog"
          />
        </div>
      )}

      <button
        type="button"
        className="xin-companion-trigger"
        aria-label={isOpen ? "收起鑫伴 业务助手" : "打开鑫伴 业务助手"}
        aria-expanded={isOpen}
        onPointerDown={handlePointerDown}
        onPointerEnter={() => setIsHovering(true)}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleToggle}
      >
        <span className="xin-companion-avatar" aria-hidden="true">
          <span className="lulu-character">
            <LuluSprite state={petState} />
          </span>
          <i className="lulu-online-dot" />
        </span>
        <strong>{isAnalyzing ? "分析中" : "鑫伴"}</strong>
      </button>
    </div>
  );
}

function loadCompanionPosition() {
  if (typeof window === "undefined") return { x: 1180, y: 680 };
  try {
    const stored = window.localStorage.getItem(XIN_COMPANION_POSITION_KEY);
    if (stored) return clampCompanionPosition(JSON.parse(stored) as { x: number; y: number });
  } catch {

  }
  return clampCompanionPosition({ x: window.innerWidth - 112, y: window.innerHeight - 124 });
}

function clampCompanionPosition(position: { x: number; y: number }) {
  if (typeof window === "undefined") return position;
  return {
    x: clamp(Number.isFinite(position.x) ? position.x : window.innerWidth - 112, XIN_COMPANION_GUTTER, Math.max(XIN_COMPANION_GUTTER, window.innerWidth - 112)),
    y: clamp(Number.isFinite(position.y) ? position.y : window.innerHeight - 124, 78, Math.max(78, window.innerHeight - 124)),
  };
}

function snapCompanionToEdge(position: { x: number; y: number }) {
  if (typeof window === "undefined") return position;
  return {
    x: position.x < window.innerWidth / 2 ? XIN_COMPANION_GUTTER : Math.max(XIN_COMPANION_GUTTER, window.innerWidth - 112),
    y: clamp(position.y, 78, Math.max(78, window.innerHeight - 124)),
  };
}

function AssistantDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="assistant-modal" role="dialog" aria-modal="true" aria-label="业务助手 放大对话">
      <button className="assistant-modal-backdrop" aria-label="关闭 业务助手" onClick={onClose} />
      <div className="assistant-modal-panel">
        {children}
      </div>
    </div>
  );
}

function buildNodeAnalyses(analysis: CustomerAnalysis, branch: BranchAnalysis, dataset: SettlementDataset): NodeAnalysis[] {
  const topNeed = analysis.needs[0];
  const topScenario = analysis.scenarios[0];
  const topBundle = analysis.bundles[0];
  const firstCoverageGap = analysis.coverage.find((item) => item.status !== "已覆盖") ?? analysis.coverage[0];
  const relations = dataset.customerRelations.filter((item) => item.customerId === analysis.customer.customerId);
  const balances = dataset.balanceSnapshots.filter((item) => item.customerId === analysis.customer.customerId);
  const industry = dataset.industryProfiles.find((item) => item.customerId === analysis.customer.customerId);
  const rules = dataset.scenarioRules.filter((item) => item.scenarioName === topScenario.scenarioName);
  const processSteps = dataset.processSteps.filter((item) => item.customerId === analysis.customer.customerId);
  const valueParameter = dataset.valueParameters.find((item) => item.customerId === analysis.customer.customerId);
  const customerEntities = [
    graphEntity(
      "customer-profile",
      "客户概况",
      analysis.customer.customerName,
      "当前分析主体",
      `${analysis.customer.industry} · ${analysis.customer.customerTier}`,
      [`行业：${analysis.customer.industry}`, `规模：${analysis.customer.customerTier}`, `客户经理：${analysis.customer.managerName}`, ...analysis.customer.tags.slice(0, 2).map((tag) => `标签：${tag}`)],
    ),
    ...relations.slice(0, 2).map((item) =>
      graphEntity(
        item.relationId,
        item.roleName,
        item.relatedName,
        "构成客户关联网络",
        `${item.relationStrength >= 0.8 ? "强" : "中"}关联主体`,
        [`关系类型：${item.relationType}`, `持股比例：${percent(item.ownershipRatio)}`, `关联强度：${percent(item.relationStrength)}`],
      ),
    ),
    ...analysis.accounts.slice(0, 2).map((item) =>
      graphEntity(
        item.accountId,
        item.accountType,
        item.accountName,
        "归属于当前客户",
        `当前余额 ${money(item.balance)}`,
        [`账户类型：${item.accountType}`, `90 日均额：${money(item.avgBalance90d)}`],
      ),
    ),
  ];
  const needEntities = [
    graphEntity("need-average", "余额指标", "90 日均额", "支撑资金需求判断", money(analysis.features.avgBalance90d), [`当前余额：${money(analysis.features.currentBalance)}`]),
    ...balances.slice(-2).map((item) =>
      graphEntity(item.snapshotId, item.balanceType, item.snapshotDate, "形成余额变化证据", money(item.balance), [`快照日期：${item.snapshotDate}`, `余额口径：${item.balanceType}`]),
    ),
    graphEntity("need-txn-evidence", "流水证据", "证据流水", "支撑需求置信度", `${topNeed.evidenceTxnIds.length} 条`, [`需求置信度：${percent(topNeed.confidence)}`]),
  ];
  const scenarioEntities = [
    graphEntity("scenario-industry", "产业链", industry?.industryChain ?? analysis.customer.industry, "提供行业经营背景", industry?.businessPattern ?? "行业经营特征待补充", [`行业：${industry?.industryName ?? analysis.customer.industry}`]),
    graphEntity("scenario-upstream", "上游标签", "上游经营主体", "解释付款端交易特征", industry?.upstreamTags.join("、") || "待补充"),
    graphEntity("scenario-downstream", "下游标签", "下游经营主体", "解释回款端交易特征", industry?.downstreamTags.join("、") || "待补充"),
    ...(rules.length
      ? rules.slice(0, 1).map((rule) => graphEntity(rule.ruleId, "识别规则", rule.ruleName, "参与场景命中计算", `权重 ${percent(rule.weight)}`, [`证据类型：${rule.evidenceType}`]))
      : topScenario.evidenceRows.slice(0, 1).map((txn) => graphEntity(txn.txnId, "场景流水", txn.counterpartyName, "支撑经营场景识别", money(txn.amount), [txn.summary]))),
  ];
  const productEntities = topBundle.products.slice(0, 3).map((product) =>
    graphEntity(product.productId, product.productType, product.productName, "匹配当前结算场景", product.valuePoint, [`办理材料：${product.requiredMaterials}`]),
  );
  productEntities.push(graphEntity("product-gap", "组合缺口", "待补齐产品", "影响组合完整度", `${topBundle.missingProducts.length} 项`, topBundle.missingProducts.map((item) => item.productName)));
  const processEntities = processSteps.slice(0, 4).map((item) =>
    graphEntity(item.processStepId, `办理动作 0${item.stepOrder}`, item.stepName, "组成客户经理办理路径", `${item.estimatedDays} 天`, [`责任角色：${item.ownerRole}`, `所需材料：${item.requiredMaterial}`]),
  );
  const usageEntities = analysis.coverage.slice(0, 3).map((item, index) =>
    graphEntity(`coverage-${index}`, "覆盖诊断", item.scenarioName, "反映场景产品覆盖状态", item.status, [`已签约：${item.signedCount}/${item.totalCount}`, `缺口产品：${item.missingProducts.join("、") || "无"}`]),
  );
  usageEntities.push(graphEntity("usage-depth", "使用深度", "交易活跃度", "反映产品使用质量", `${analysis.usages.filter((item) => item.activated).length} 项已激活`, [`使用记录：${analysis.usages.length} 项`]));
  const valueEntities = [
    graphEntity("value-owner", "责任人", analysis.value.actionOwner, "负责承接下一步动作", analysis.value.nextAction),
    graphEntity("value-score", "机会评分", "盘户优先级", "参与客户机会排序", `${valueParameter?.opportunityScore ?? "待计算"} 分`),
    graphEntity("value-deposit", "留存参数", "存款沉淀", "形成存款提升测算", percent(valueParameter?.depositRetentionRate ?? 0), [`预计提升：${money(analysis.value.estimatedDepositIncrease)}`]),
    graphEntity("value-txn", "承接参数", "交易提升", "形成交易提升测算", percent(valueParameter?.txnCaptureRate ?? 0), [`预计提升：${money(analysis.value.estimatedTxnIncrease)}`, `相似客户：${valueParameter?.similarCustomerCount ?? 0} 户`]),
  ];
  const nodeAnalyses: NodeAnalysis[] = [
    {
      stepId: "customer",
      title: `${analysis.customer.industry}客户，由${analysis.customer.managerName}维护，主体、账户与数据范围已确认。`,
      result: analysis.customer.customerName,
      metric: `${analysis.customer.customerTier} / ${analysis.customer.branchName}`,
      evidence: [
        ...relations.slice(0, 5).map((item) => `${item.roleName}：${item.relatedName}`),
        ...analysis.accounts.slice(0, 2).map((item) => `${item.accountType}：${item.accountName}`),
      ],
      entities: customerEntities,
    },
    {
      stepId: "need",
      title: topNeed.explanation,
      result: topNeed.needType,
      metric: `${percent(topNeed.confidence)} 置信度`,
      evidence: [
        `90 日均额 ${money(analysis.features.avgBalance90d)}`,
        ...balances.slice(-3).map((item) => `${item.snapshotDate} ${item.balanceType} ${money(item.balance)}`),
        `证据流水 ${topNeed.evidenceTxnIds.length} 条`,
      ],
      entities: needEntities,
    },
    {
      stepId: "scenario",
      title: topScenario.evidence,
      result: topScenario.scenarioName,
      metric: `${percent(topScenario.confidence)} 场景命中`,
      evidence: [
        `${industry?.industryChain ?? analysis.customer.industry}：${industry?.businessPattern ?? "行业经营特征待补充"}`,
        `上游：${industry?.upstreamTags.join("、") ?? "待补充"}`,
        `下游：${industry?.downstreamTags.join("、") ?? "待补充"}`,
        ...rules.slice(0, 2).map((rule) => `规则：${rule.ruleName} / 权重 ${percent(rule.weight)}`),
        ...topScenario.evidenceRows.slice(0, 2).map((txn) => `${txn.counterpartyName} ${money(txn.amount)} ${txn.summary}`),
      ],
      entities: scenarioEntities,
    },
    {
      stepId: "product",
      title: topBundle.fitReason,
      result: topBundle.bundleName,
      metric: `${topBundle.missingProducts.length} 项缺口产品`,
      evidence: topBundle.products.slice(0, 3).map((product) => `${product.productName}：${product.valuePoint}`),
      entities: productEntities,
    },
    {
      stepId: "process",
      title: topBundle.verifyQuestion,
      result: "办理作战卡已生成",
      metric: `${topBundle.products.length} 项组合产品`,
      evidence: processSteps.map((item) => `${item.stepOrder}. ${item.stepName} / ${item.ownerRole} / ${item.estimatedDays} 天`),
      entities: processEntities,
    },
    {
      stepId: "usage",
      title: firstCoverageGap?.description ?? "当前场景覆盖较完整，下一步关注使用频率和交易留存。",
      result: firstCoverageGap?.status ?? "已覆盖",
      metric: `${analysis.coverage.filter((item) => item.status !== "已覆盖").length} 个待补齐场景`,
      evidence: analysis.coverage.slice(0, 3).map((item) => `${item.scenarioName}：${item.status}`),
      entities: usageEntities,
    },
    {
      stepId: "value",
      title: analysis.value.nextAction,
      result: `预计沉淀 ${money(analysis.value.estimatedDepositIncrease)}`,
      metric: `交易提升 ${money(analysis.value.estimatedTxnIncrease)}`,
      evidence: [
        `责任人：${analysis.value.actionOwner}`,
        `机会评分：${valueParameter?.opportunityScore ?? "待计算"}`,
        `存款留存率：${percent(valueParameter?.depositRetentionRate ?? 0)}`,
        `交易承接率：${percent(valueParameter?.txnCaptureRate ?? 0)}`,
        `相似客户：${valueParameter?.similarCustomerCount ?? 0} 户`,
      ],
      entities: valueEntities,
    },
  ];
  return nodeAnalyses.map((item) => hydrateDatabaseGraph(item, analysis.customer.customerId, dataset));
}

function graphEntity(id: string, badge: string, label: string, relation: string, detail: string, details: string[] = []): GraphEntity {
  return { badge, detail, details, id, label, relation };
}

function hydrateDatabaseGraph(item: NodeAnalysis, customerId: string, dataset: SettlementDataset): NodeAnalysis {
  const nodes = dataset.ontologyGraphNodes.filter((node) => node.customerId === customerId && node.stepId === item.stepId);
  const center = nodes.find((node) => node.nodeId.endsWith("-center"));
  if (!center) return item;
  const entities = nodes
    .filter((node) => node.nodeId !== center.nodeId)
    .map((node) => {
      const incomingEdge = dataset.ontologyGraphEdges.find((edge) => edge.customerId === customerId && edge.stepId === item.stepId && edge.targetNodeId === node.nodeId);
      return {
        badge: node.nodeBadge,
        detail: node.nodeDetail,
        details: node.details,
        id: node.nodeId,
        label: node.nodeName,
        relation: incomingEdge?.relationName ?? "",
        x: node.positionX,
        y: node.positionY,
      };
    });
  const relations: GraphRelation[] = dataset.ontologyGraphEdges
    .filter((edge) => edge.customerId === customerId && edge.stepId === item.stepId)
    .map((edge) => ({
      detail: edge.relationDetail,
      id: edge.edgeId,
      label: edge.relationName,
      sourceId: edge.sourceNodeId,
      targetId: edge.targetNodeId,
      weight: edge.weight,
    }));
  return {
    ...item,
    entities,
    relations,
    result: center.nodeName,
    rootNodeId: center.nodeId,
  };
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function money(value: number): string {
  if (value >= 10000) return `${Math.round(value / 10000)} 万`;
  return value.toLocaleString("zh-CN");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function createComputationDurations(): [number, number, number] {
  const randomPhaseDuration = () => 3000 + Math.floor(Math.random() * 2001);
  return [randomPhaseDuration(), randomPhaseDuration(), randomPhaseDuration()];
}

function rotateGraphPoint(x: number, y: number, rotation: number): { x: number; y: number } {
  const radians = (rotation * Math.PI) / 180;
  const offsetX = x - 50;
  const offsetY = y - 52;
  return {
    x: 50 + offsetX * Math.cos(radians) - offsetY * Math.sin(radians),
    y: 52 + offsetX * Math.sin(radians) + offsetY * Math.cos(radians),
  };
}

function tabForStep(stepId: OntologyStep["id"]): WorkbenchTab {
  if (stepId === "product" || stepId === "usage") return "plan";
  if (stepId === "process") return "battle";
  if (stepId === "value") return "value";
  return "evidence";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter((value) => Boolean(value)))];
}
