import type { AiInsight, CustomerAnalysis } from "../types";

export const ASSISTANT_PROMPT_KEYS = {
  NODE_INSIGHT: "node_insight",
  EVIDENCE_EXPLANATION: "evidence_explanation",
  PRODUCT_BUNDLE: "product_bundle",
  BATTLE_CARD: "battle_card",
  BRANCH_REPORT: "branch_report",
  CUSTOMER_VISIT_MINUTES: "customer_visit_minutes",
  PRODUCT_KNOWLEDGE_QA: "product_knowledge_qa",
  OPEN_CUSTOMER_QA: "open_customer_qa",
} as const;

export const STAGE_QUESTIONS: Record<string, string[]> = {
  customer: [
    "这户客户的基本画像是什么？",
    "为什么值得优先盘？",
    "当前账户和资金规模怎么样？",
    "最适合从什么方向切入？",
  ],
  need: [
    "当前识别出哪些资金需求？",
    "最强资金需求是什么？",
    "判断这个需求的依据是什么？",
    "还需要向客户核实什么？",
  ],
  scenario: [
    "当前识别出哪些结算场景？",
    "为什么优先判断为这个场景？",
    "哪些流水是关键证据？",
    "拜访客户时应该核实什么？",
  ],
  product: [
    "推荐的产品组合是什么？",
    "为什么推荐这个组合？",
    "当前缺少哪些产品？",
    "客户暂不接受时怎么分步推进？",
  ],
  process: [
    "下一步办理路径是什么？",
    "拜访前要准备哪些材料？",
    "生成客户经理沟通话术",
    "各环节由谁负责？",
  ],
  usage: [
    "当前产品覆盖情况怎么样？",
    "哪些产品已经激活使用？",
    "哪些产品是缺口或沉睡？",
    "后续如何提升使用深度？",
  ],
  value: [
    "这户客户预计能带来多少价值？",
    "价值测算的依据是什么？",
    "为什么值得在支行内复制？",
    "生成支行汇报摘要",
  ],
};

export function isFixedStageQuestion(question: string, activeStepId: string): boolean {
  return (STAGE_QUESTIONS[activeStepId] ?? []).includes(question.trim());
}

export function buildNodeInsight(analysis: CustomerAnalysis, activeStepId: string): AiInsight {
  const { customer, needs, scenarios, bundles, coverage, value } = analysis;
  const topNeed = needs[0];
  const topScenario = scenarios[0];
  const topBundle = bundles[0];

  const insights: Record<string, AiInsight> = {
    customer: {
      title: "客户识别",
      promptKey: ASSISTANT_PROMPT_KEYS.NODE_INSIGHT,
      text: `${customer.customerName}属于${customer.industry}行业，当前由${customer.managerName}维护。系统建议先从${customer.tags.join("、")}两个方向切入，避免把结算提升做成单一产品推荐。`,
      prompts: STAGE_QUESTIONS.customer,
    },
    need: {
      title: "资金需求解释",
      promptKey: ASSISTANT_PROMPT_KEYS.NODE_INSIGHT,
      text: `${topNeed.needType}是当前最强需求，置信度 ${percent(topNeed.confidence)}。判断依据是：${topNeed.explanation}`,
      prompts: STAGE_QUESTIONS.need,
    },
    scenario: {
      title: "场景故事",
      promptKey: ASSISTANT_PROMPT_KEYS.EVIDENCE_EXPLANATION,
      text: `${topScenario.scenarioName}被优先识别。流水证据显示：${topScenario.evidence}。建议客户经理进一步追问业务背景，而不是直接推产品。`,
      prompts: STAGE_QUESTIONS.scenario,
    },
    product: {
      title: "产品组合建议",
      promptKey: ASSISTANT_PROMPT_KEYS.PRODUCT_BUNDLE,
      text: `建议组合为：${topBundle.bundleName}。推荐逻辑是先解决${topScenario.scenarioName}中的效率、对账和资金留存问题，再根据客户接受度分步推进。`,
      prompts: STAGE_QUESTIONS.product,
    },
    process: {
      title: "办理作战卡",
      promptKey: ASSISTANT_PROMPT_KEYS.BATTLE_CARD,
      text: buildBattleCard(analysis),
      prompts: STAGE_QUESTIONS.process,
    },
    usage: {
      title: "使用诊断",
      promptKey: ASSISTANT_PROMPT_KEYS.NODE_INSIGHT,
      text: `当前覆盖状态为：${coverage.map((item) => `${item.scenarioName}${item.status}`).join("；")}。优先处理未覆盖和部分覆盖场景。`,
      prompts: STAGE_QUESTIONS.usage,
    },
    value: {
      title: "价值闭环",
      promptKey: ASSISTANT_PROMPT_KEYS.BRANCH_REPORT,
      text: `预计可提升存款沉淀 ${money(value.estimatedDepositIncrease)}，带动结算交易 ${money(value.estimatedTxnIncrease)}。建议动作：${value.nextAction}`,
      prompts: STAGE_QUESTIONS.value,
    },
  };

  return insights[activeStepId] ?? insights.customer;
}

export interface AnswerMeta {
  text: string;
  confidence: number;
  sources: string[];
}

export function answerQuestion(question: string, analysis: CustomerAnalysis, activeStepId = "customer"): AnswerMeta {
  const normalized = question.trim();
  if (!normalized) {
    return {
      text: "可以围绕当前客户的资金需求、场景证据、产品组合或办理动作继续追问。",
      confidence: 0.5,
      sources: ["系统默认回复"],
    };
  }

  const stageAnswer = buildStageAnswer(normalized, analysis, activeStepId);
  if (stageAnswer) return stageAnswer;

  if (activeStepId === "need") {
    const needs = analysis.needs.slice(0, 3);
    return {
      text: `${analysis.customer.customerName}当前识别出${needs.length}项主要资金需求：${needs.map((item) => item.needType).join("、")}。本环节只说明客户需要解决的资金问题；建议继续核实资金规模、发生时点、持续期限和当前安排方式，再进入下一环判断结算场景。`,
      confidence: needs[0]?.confidence ?? 0.7,
      sources: needs.map((item) => `${item.needType}：${item.evidenceTxnIds.length}条资金证据`),
    };
  }

  if (activeStepId === "scenario") {
    const scenario = analysis.scenarios[0];
    const triggerNeed = analysis.needs.find((item) => item.needId === scenario.triggerNeedId) ?? analysis.needs[0];
    return {
      text: `承接上一环已确认的“${triggerNeed.needType}”，当前优先评估为“${scenario.scenarioName}”。判断依据是：${scenario.evidence}。本环节只确认经营活动与证据，不提前推荐产品。`,
      confidence: scenario.confidence,
      sources: [`触发需求：${triggerNeed.needType}`, `场景证据：${scenario.evidenceRows.length}条`],
    };
  }

  if (/作战卡|办理|材料|话术|沟通/.test(normalized)) {
    return {
      text: buildBattleCard(analysis),
      confidence: 0.92,
      sources: [`产品组合：${analysis.bundles[0].bundleName}`, `场景规则：${analysis.scenarios[0].scenarioName}`],
    };
  }
  if (/报告|支行|摘要|汇报/.test(normalized)) {
    return {
      text: buildReportSummary(analysis),
      confidence: 0.88,
      sources: [`价值测算：存款提升 ${money(analysis.value.estimatedDepositIncrease)}`, `场景命中：${analysis.scenarios[0].scenarioName}`],
    };
  }
  if (/产品|组合|推荐|备选/.test(normalized)) {
    return {
      text: explainBundle(analysis),
      confidence: 0.85,
      sources: [`场景匹配：${analysis.scenarios[0].scenarioName}`, `产品目录：${analysis.bundles[0].products.length} 项`],
    };
  }
  if (/为什么|依据|证据|判断/.test(normalized)) {
    const scenario = analysis.scenarios[0];
    return {
      text: explainEvidence(analysis),
      confidence: scenario.confidence,
      sources: [`证据流水：${scenario.evidenceRows.length} 条`, `命中规则：${scenario.evidence}`],
    };
  }
  if (/下一步|动作|跟进|拜访|问/.test(normalized)) {
    return {
      text: buildNextActions(analysis),
      confidence: 0.82,
      sources: [`核实问题：${analysis.bundles[0].verifyQuestion}`, `价值动作：${analysis.value.nextAction}`],
    };
  }

  return {
    text: `${analysis.customer.customerName}当前最适合沿着"${analysis.needs[0].needType} -> ${analysis.scenarios[0].scenarioName} -> ${analysis.bundles[0].bundleName}"推进。建议先看证据流水，再用作战卡转成客户经理动作。`,
    confidence: 0.7,
    sources: [`资金需求：${analysis.needs[0].needType}`, `置信度：${percent(analysis.needs[0].confidence)}`],
  };
}

function buildStageAnswer(question: string, analysis: CustomerAnalysis, activeStepId: string): AnswerMeta | undefined {
  const { customer, accounts, features, needs, scenarios, bundles, coverage, usages, value } = analysis;
  const topNeed = needs[0];
  const topScenario = scenarios[0];
  const topBundle = bundles[0];
  const totalAverageBalance = accounts.reduce((total, item) => total + item.avgBalance90d, 0);
  const accountSummary = accounts.map((item) => `${item.accountName}${money(item.balance)}`).join("、");
  const evidenceRows = topScenario.evidenceRows.slice(0, 3);
  const evidenceSummary = evidenceRows.map((item) => `${item.txnDate}向${item.counterpartyName}${item.direction === "in" ? "收入" : "支出"}${money(item.amount)}（${item.summary}）`).join("；");
  const missingProducts = unique(bundles.flatMap((item) => item.missingProducts.map((product) => product.productName)));
  const bundleProducts = unique(bundles.flatMap((item) => item.products.map((product) => product.productName)));
  const productNameById = new Map(bundles.flatMap((item) => item.products).map((product) => [product.productId, product.productName]));
  const activeProducts = usages.filter((item) => item.activated).map((item) => productNameById.get(item.productId) ?? item.productId);
  const dormantProducts = usages.filter((item) => item.signed && !item.activated).map((item) => productNameById.get(item.productId) ?? item.productId);
  const materials = unique(topBundle.products.flatMap((item) => item.requiredMaterials.split("、"))).slice(0, 7);

  const answers: Record<string, Record<string, AnswerMeta>> = {
    customer: {
      "这户客户的基本画像是什么？": reply(
        `${customer.customerName}是${customer.industry}行业的${customer.customerTier}，由${customer.managerName}负责维护，当前标签为${customer.tags.join("、")}。客户共有${accounts.length}个账户、${analysis.transactions.length}笔近90日流水。`,
        0.96,
        ["客户基本信息", "账户台账", "近90日流水"],
      ),
      "为什么值得优先盘？": reply(
        `该客户当前余额${money(features.currentBalance)}，90日账户平均余额合计${money(totalAverageBalance)}，同时命中${topNeed.needType}和${topScenario.scenarioName}。资金规模、场景证据和产品缺口同时存在，具备优先盘户价值。`,
        0.91,
        ["账户余额", `需求置信度${percent(topNeed.confidence)}`, `场景置信度${percent(topScenario.confidence)}`],
      ),
      "当前账户和资金规模怎么样？": reply(
        `客户共有${accounts.length}个账户：${accountSummary}。当前余额合计${money(features.currentBalance)}，90日账户平均余额合计${money(totalAverageBalance)}，资金规模处于可重点经营区间。`,
        0.97,
        accounts.map((item) => `${item.accountName}余额${money(item.balance)}`),
      ),
      "最适合从什么方向切入？": reply(
        `建议先从“${topNeed.needType}”切入，再自然过渡到“${topScenario.scenarioName}”。开场不要直接推产品，可以先核实：${topBundle.verifyQuestion}`,
        0.89,
        [`客户标签：${customer.tags.join("、")}`, `主场景：${topScenario.scenarioName}`],
      ),
    },
    need: {
      "当前识别出哪些资金需求？": reply(
        `当前识别出${needs.length}项主要资金需求：${needs.map((item) => `${item.needType}（${percent(item.confidence)}）`).join("、")}。建议优先处理置信度最高、且能由流水直接解释的需求。`,
        0.94,
        needs.map((item) => `${item.needType}：${item.evidenceTxnIds.length}条证据`),
      ),
      "最强资金需求是什么？": reply(
        `最强资金需求是“${topNeed.needType}”，置信度${percent(topNeed.confidence)}。业务解释是：${topNeed.explanation}`,
        topNeed.confidence,
        [`需求证据流水${topNeed.evidenceTxnIds.length}条`, `当前余额${money(features.currentBalance)}`],
      ),
      "判断这个需求的依据是什么？": reply(
        `判断依据来自账户水位和交易行为：当前余额${money(features.currentBalance)}，90日账户平均余额合计${money(totalAverageBalance)}，近90日支出${features.outgoingCount}笔、收入${features.incomingCount}笔。${topNeed.explanation}`,
        0.92,
        ["账户余额与90日均额", "近90日收支笔数", `证据流水${topNeed.evidenceTxnIds.length}条`],
      ),
      "还需要向客户核实什么？": reply(
        "建议重点核实四点：一是资金需求的预计规模；二是资金发生和使用的具体时点；三是资金需要保留多久；四是客户当前依靠什么方式安排资金、最希望改善哪项资金管理问题。",
        0.84,
        ["资金规模待确认", "发生时点与持续期限待确认", "当前资金安排方式待确认"],
      ),
    },
    scenario: {
      "当前识别出哪些结算场景？": reply(
        `当前识别出${scenarios.length}个主要结算场景：${scenarios.map((item) => `${item.scenarioName}（${percent(item.confidence)}）`).join("、")}。当前优先场景为${topScenario.scenarioName}。`,
        0.95,
        scenarios.map((item) => `${item.scenarioName}：${item.evidenceRows.length}笔证据`),
      ),
      "为什么优先判断为这个场景？": reply(
        `优先判断为“${topScenario.scenarioName}”，因为${topScenario.evidence}。当前共有${topScenario.evidenceRows.length}笔相关证据，且与${customer.industry}行业的经营特点相吻合。`,
        topScenario.confidence,
        [`命中规则：${topScenario.evidence}`, `行业：${customer.industry}`],
      ),
      "哪些流水是关键证据？": reply(
        `代表性证据包括：${evidenceSummary}。这些交易在对手方、摘要和发生频率上具有连续性，因此不是一次偶发付款。`,
        0.93,
        evidenceRows.map((item) => `${item.txnDate} ${item.summary} ${money(item.amount)}`),
      ),
      "拜访客户时应该核实什么？": reply(
        `建议围绕真实经营背景核实：${topBundle.verifyQuestion}同时确认主要交易对手是否稳定、付款是否按固定周期发生，以及当前财务系统如何完成审批和对账。`,
        0.86,
        ["场景证据待客户确认", `主场景：${topScenario.scenarioName}`],
      ),
    },
    product: {
      "推荐的产品组合是什么？": reply(
        `围绕${topScenario.scenarioName}，建议产品组合为：${topBundle.bundleName}。组合内产品共同解决支付效率、系统连接、对账和资金留存问题。`,
        0.94,
        bundleProducts.map((item) => `产品目录：${item}`),
      ),
      "为什么推荐这个组合？": reply(
        `该组合直接匹配${topScenario.scenarioName}。${topBundle.products.map((item) => `${item.productName}用于${item.valuePoint}`).join("；")}。组合推荐是为了解决完整场景，而不是销售单一产品。`,
        0.91,
        [`场景匹配：${topScenario.scenarioName}`, `组合产品${topBundle.products.length}项`],
      ),
      "当前缺少哪些产品？": reply(
        `当前产品缺口为：${missingProducts.length ? missingProducts.join("、") : "暂无明显缺口"}。建议先核实签约和激活状态，再按对客户经营影响由高到低补齐。`,
        0.95,
        coverage.map((item) => `${item.scenarioName}：${item.status}`),
      ),
      "客户暂不接受时怎么分步推进？": reply(
        `可以分三步推进：第一步用证据流水确认痛点；第二步从电子回单、企业网银等低门槛能力切入；第三步在客户认可后推进${missingProducts.slice(0, 2).join("、") || topBundle.bundleName}，逐步形成完整组合。`,
        0.83,
        [`当前缺口：${missingProducts.join("、") || "无"}`, "分阶段产品策略"],
      ),
    },
    process: {
      "下一步办理路径是什么？": reply(buildNextActions(analysis), 0.93, ["办理作战卡", `责任人：${customer.managerName}`]),
      "拜访前要准备哪些材料？": reply(
        `拜访前建议准备：关键证据流水、近90日余额变化、产品覆盖缺口，以及${materials.join("、")}。现场先确认真实需求，再决定正式办理材料。`,
        0.94,
        topBundle.products.map((item) => `${item.productName}办理要求`),
      ),
      "生成客户经理沟通话术": reply(
        `${customer.customerName}您好，我们结合贵司近90日流水，发现${topScenario.evidence}，可能存在${topNeed.needType}需求。我们想先了解贵司目前在审批、付款和对账上的实际做法，再讨论是否通过${topBundle.bundleName}分步提升效率。`,
        0.9,
        [`场景：${topScenario.scenarioName}`, `核实问题：${topBundle.verifyQuestion}`],
      ),
      "各环节由谁负责？": reply(
        `建议由${customer.managerName}担任主责任人，负责客户沟通和需求确认；产品经理负责产品方案与材料核验；运营支持岗负责审批、系统配置和开通；开通后仍由${customer.managerName}跟踪首月使用效果。`,
        0.88,
        ["客户经理", "产品经理", "运营支持岗"],
      ),
    },
    usage: {
      "当前产品覆盖情况怎么样？": reply(
        `当前场景覆盖情况为：${coverage.map((item) => `${item.scenarioName}${item.status}（${item.signedCount}/${item.totalCount}）`).join("；")}。应优先处理未覆盖和部分覆盖场景。`,
        0.95,
        coverage.map((item) => `${item.scenarioName}：${item.description}`),
      ),
      "哪些产品已经激活使用？": reply(
        `当前已激活使用的产品有${activeProducts.length}项：${activeProducts.join("、") || "暂无"}。产品使用记录共${usages.length}项，应继续关注实际交易频率而不只看是否签约。`,
        0.96,
        usages.filter((item) => item.activated).map((item) => `${productNameById.get(item.productId) ?? item.productId}：${item.txnCount90d}笔`),
      ),
      "哪些产品是缺口或沉睡？": reply(
        `未覆盖产品包括：${missingProducts.join("、") || "暂无"}；已签约但未激活的产品包括：${dormantProducts.join("、") || "暂无"}。两类问题应分别采取补签约和促激活动作。`,
        0.94,
        [`产品缺口${missingProducts.length}项`, `待激活产品${dormantProducts.length}项`],
      ),
      "后续如何提升使用深度？": reply(
        `建议先补齐${missingProducts.slice(0, 2).join("、") || "关键产品"}，再设定首月使用目标：完成首次交易、核验自动对账效果，并在30天后复盘交易笔数、金额和账户沉淀变化。`,
        0.86,
        ["首月使用跟踪", "签约激活与交易留存"],
      ),
    },
    value: {
      "这户客户预计能带来多少价值？": reply(
        `预计可提升存款沉淀${money(value.estimatedDepositIncrease)}，带动结算交易${money(value.estimatedTxnIncrease)}。这是一项基于当前余额、场景交易和演示参数的机会测算，不等同于最终承诺收益。`,
        0.9,
        [`预计存款提升${money(value.estimatedDepositIncrease)}`, `预计交易提升${money(value.estimatedTxnIncrease)}`],
      ),
      "价值测算的依据是什么？": reply(
        `测算主要参考当前余额${money(features.currentBalance)}、90日账户平均余额合计${money(totalAverageBalance)}、${topScenario.scenarioName}证据交易规模，以及产品覆盖缺口。最终结果用于机会排序，实际落地前仍需客户确认。`,
        0.86,
        ["账户余额", "场景证据交易", "产品覆盖情况"],
      ),
      "为什么值得在支行内复制？": reply(
        `${customer.industry}客户的${topScenario.scenarioName}具有清晰的流水特征、规则依据和标准产品组合，容易形成“识别证据—核实需求—补齐产品—跟踪价值”的标准打法，因此适合在同类客户中复制。`,
        0.84,
        [`样板场景：${topScenario.scenarioName}`, `标准组合：${topBundle.bundleName}`],
      ),
      "生成支行汇报摘要": reply(buildReportSummary(analysis), 0.9, [`客户：${customer.customerName}`, `责任人：${customer.managerName}`]),
    },
  };

  return answers[activeStepId]?.[question];
}

function reply(text: string, confidence: number, sources: string[]): AnswerMeta {
  return { text, confidence, sources };
}

export function selectPromptKey(question: string): string {
  const normalized = question.trim();
  if (/报告|支行|摘要|汇报/.test(normalized)) return ASSISTANT_PROMPT_KEYS.BRANCH_REPORT;
  if (/作战卡|办理|材料|话术|沟通/.test(normalized)) return ASSISTANT_PROMPT_KEYS.BATTLE_CARD;
  if (/产品|组合|推荐|备选/.test(normalized)) return ASSISTANT_PROMPT_KEYS.PRODUCT_BUNDLE;
  if (/为什么|依据|证据|判断/.test(normalized)) return ASSISTANT_PROMPT_KEYS.EVIDENCE_EXPLANATION;
  return ASSISTANT_PROMPT_KEYS.NODE_INSIGHT;
}

export function buildBattleCard(analysis: CustomerAnalysis): string {
  const bundle = analysis.bundles[0];
  const materials = unique(bundle.products.flatMap((item) => item.requiredMaterials.split("、")));
  return [
    `推荐组合：${bundle.bundleName}`,
    "拜访前准备：带上命中流水、主要对手方、近 90 日余额变化和产品缺口。",
    `核实问题：${bundle.verifyQuestion}`,
    `材料清单：${materials.slice(0, 5).join("、")}。`,
    `沟通话术：我们不是单独推荐产品，而是根据贵司流水里反复出现的${bundle.scenarioName}，设计一套提升效率和对账质量的结算服务方案。`,
    `跟进动作：${analysis.value.nextAction}`,
  ].join("\n");
}

export function buildReportSummary(analysis: CustomerAnalysis): string {
  const { customer, scenarios, bundles, value } = analysis;
  return `${customer.branchName}可将${customer.customerName}作为${scenarios[0].scenarioName}样板户推进。建议产品组合为${bundles[0].bundleName}，预计提升存款沉淀 ${money(value.estimatedDepositIncrease)}，带动结算交易 ${money(value.estimatedTxnIncrease)}。下一步由${customer.managerName}核实客户真实办理意愿和系统对接条件。`;
}

function explainEvidence(analysis: CustomerAnalysis): string {
  const scenario = analysis.scenarios[0];
  const rows = scenario.evidenceRows.slice(0, 3).map((item) => `${item.txnDate} ${item.counterpartyName} ${money(item.amount)} ${item.summary}`);
  return `当前主要依据是${scenario.scenarioName}的流水证据：${scenario.evidence}。代表流水包括：${rows.join("；")}。这些证据共同说明客户不是偶发交易，而是存在稳定经营结算链路。`;
}

function explainBundle(analysis: CustomerAnalysis): string {
  const bundle = analysis.bundles[0];
  const missing = bundle.missingProducts.map((item) => item.productName);
  return `推荐 ${bundle.bundleName}，因为它能同时覆盖${bundle.scenarioName}的付款、对账和效率问题。当前缺口产品为：${missing.length ? missing.join("、") : "暂无明显缺口"}。若客户接受度有限，可以先从企业网银/电子回单等低门槛产品切入。`;
}

function buildNextActions(analysis: CustomerAnalysis): string {
  return [
    `1. 先向客户确认：${analysis.bundles[0].verifyQuestion}`,
    `2. 用证据流水说明系统识别到的${analysis.scenarios[0].scenarioName}。`,
    `3. 以${analysis.bundles[0].bundleName}作为组合服务方案，而不是单品营销。`,
    `4. 跟进动作：${analysis.value.nextAction}`,
  ].join("\n");
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function money(value: number): string {
  if (value >= 10000) return `${Math.round(value / 10000)} 万元`;
  return `${value.toLocaleString("zh-CN")} 元`;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
