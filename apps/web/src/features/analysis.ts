import type {
  Account,
  BranchAnalysis,
  CoverageRow,
  Customer,
  CustomerAnalysis,
  FeatureSet,
  FundNeed,
  OntologyStep,
  Product,
  ProductBundle,
  ProductUsage,
  Scenario,
  SettlementDataset,
  Transaction,
  ValueResult,
} from "../types";

export const ontologySteps: OntologyStep[] = [
  { id: "customer", label: "客户", tone: "cyan" },
  { id: "need", label: "资金需求", tone: "blue" },
  { id: "scenario", label: "结算场景", tone: "violet" },
  { id: "product", label: "结算产品", tone: "amber" },
  { id: "process", label: "办理流程", tone: "green" },
  { id: "usage", label: "使用诊断", tone: "pink" },
  { id: "value", label: "价值结果", tone: "lime" },
];

const bundleRules: Record<string, string[]> = {
  供应商付款场景: ["PRD-BATCH-PAY", "PRD-DIRECT", "PRD-RECEIPT"],
  闲置资金沉淀场景: ["PRD-CASH", "PRD-AGREEMENT", "PRD-NOTICE"],
  车辆出行场景: ["PRD-ETC", "PRD-CARD"],
  代发工资场景: ["PRD-PAYROLL", "PRD-EBANK"],
  税费社保缴纳场景: ["PRD-EBANK", "PRD-RECEIPT"],
  门店收款场景: ["PRD-COLLECT", "PRD-EBANK"],
  资金归集场景: ["PRD-CASH", "PRD-DIRECT"],
  银企对接场景: ["PRD-DIRECT", "PRD-RECEIPT"],
};

const industryPrimaryScenario: Record<string, string> = {
  高端制造: "供应商付款场景",
  连锁餐饮: "门店收款场景",
  物流运输: "车辆出行场景",
  医药流通: "供应商付款场景",
  物业服务: "代发工资场景",
  科技服务: "资金归集场景",
  建筑工程: "供应商付款场景",
  跨境电商: "银企对接场景",
  教育培训: "代发工资场景",
  新能源: "银企对接场景",
};

export function analyzeCustomer(customer: Customer, dataset: SettlementDataset): CustomerAnalysis {
  const { accounts, productUsage, products, transactions } = dataset;
  const customerAccounts = accounts.filter((item) => item.customerId === customer.customerId);
  const rawTxns = transactions.filter((item) => item.customerId === customer.customerId);
  const txns = assignVerificationStatus(rawTxns);
  const usageRows = productUsage.filter((item) => item.customerId === customer.customerId);
  const features = buildFeatures(customerAccounts, txns);
  const needs = detectFundNeeds(customer, features, txns);
  const scenarios = detectScenarios(customer, features, txns, needs);
  const bundles = matchProductBundles(scenarios, usageRows, products);
  const coverage = diagnoseCoverage(scenarios, bundles, usageRows);
  const value = calculateValue(customer, features, scenarios, coverage);

  return {
    customer,
    accounts: customerAccounts,
    transactions: txns,
    usages: usageRows,
    features,
    needs,
    scenarios,
    bundles,
    coverage,
    value,
  };
}

export function analyzeBranch(customers: Customer[], dataset: SettlementDataset): BranchAnalysis {
  const analyses = customers.map((customer) => analyzeCustomer(customer, dataset));
  const scenarioCounts = countBy(analyses.flatMap((item) => item.scenarios.map((scenarioItem) => scenarioItem.scenarioName)));
  const opportunities = analyses
    .map((item) => ({
      customerId: item.customer.customerId,
      customerName: item.customer.customerName,
      managerName: item.customer.managerName,
      topScenario: item.scenarios[0]?.scenarioName ?? "待核实场景",
      opportunity: item.bundles[0]?.bundleName ?? "补充结算画像",
      nextAction: item.value.nextAction,
      estimatedDepositIncrease: item.value.estimatedDepositIncrease,
      estimatedTxnIncrease: item.value.estimatedTxnIncrease,
    }))
    .sort((a, b) => b.estimatedDepositIncrease + b.estimatedTxnIncrease - (a.estimatedDepositIncrease + a.estimatedTxnIncrease));

  return {
    customerCount: analyses.length,
    scenarioCounts,
    opportunityCount: opportunities.length,
    totalDepositIncrease: sum(opportunities, "estimatedDepositIncrease"),
    totalTxnIncrease: sum(opportunities, "estimatedTxnIncrease"),
    opportunities,
  };
}

function buildFeatures(customerAccounts: Account[], txns: Transaction[]): FeatureSet {
  const outgoing = txns.filter((item) => item.direction === "out");
  const incoming = txns.filter((item) => item.direction === "in");
  const avgBalance90d = Math.round(sum(customerAccounts, "avgBalance90d") / Math.max(customerAccounts.length, 1));
  const currentBalance = sum(customerAccounts, "balance");
  const supplierTxns = outgoing.filter((item) => /供应商|采购|货款|服务费|外协/.test(item.summary));
  const vehicleTxns = outgoing.filter((item) => /ETC|高速|加油|停车|车辆|维修/.test(`${item.summary}${item.counterpartyName}`));
  const payrollTxns = outgoing.filter((item) => /工资|薪酬/.test(item.summary));
  const taxTxns = outgoing.filter((item) => /税|社保|公积金/.test(`${item.summary}${item.counterpartyName}`));
  const collectTxns = incoming.filter((item) => /门店|收款|清算/.test(`${item.summary}${item.counterpartyName}`));
  const transferTxns = txns.filter((item) => /内部|调拨|归集|划转/.test(item.summary));
  const directTxns = txns.filter((item) => item.channel === "银企直联");
  const counterpartyGroups = countBy(outgoing.map((item) => item.counterpartyName));

  return {
    avgBalance90d,
    currentBalance,
    outgoingCount: outgoing.length,
    incomingCount: incoming.length,
    supplierTxns,
    vehicleTxns,
    payrollTxns,
    taxTxns,
    collectTxns,
    transferTxns,
    directTxns,
    topCounterparties: Object.entries(counterpartyGroups)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4),
  };
}

function detectFundNeeds(customer: Customer, features: FeatureSet, txns: Transaction[]): FundNeed[] {
  const needs: FundNeed[] = [];

  if (features.avgBalance90d > 4500000) {
    needs.push(need("NEED-IDLE-CASH", "阶段性闲置资金增值", 0.88, pickEvidence(txns, "in", 3), "近 90 日均余额处于较高水平，月末资金沉淀明显，客户需要兼顾日常流动性与阶段性资金增值。"));
  }

  if (features.supplierTxns.length >= 3 || features.outgoingCount >= 7) {
    needs.push(need("NEED-PAYMENT-EFFICIENCY", "高频付款效率提升", 0.9, features.supplierTxns.slice(0, 4).map((item) => item.txnId), "对公支出频率较高且固定收款方重复出现，客户需要降低重复录入、审批与对账的人工作业压力。"));
  }

  if (features.transferTxns.length >= 2) {
    needs.push(need("NEED-CASH-POOL", "多账户资金统筹", 0.82, features.transferTxns.map((item) => item.txnId), "多账户或项目资金之间存在内部划转，客户需要更及时地掌握分散资金并统一安排可用额度。"));
  }

  if (features.payrollTxns.length >= 2) {
    needs.push(need("NEED-PAYROLL", "周期性薪酬支付", 0.84, features.payrollTxns.map((item) => item.txnId), "固定日期持续出现工资薪酬类支出，客户需要稳定、准时并可核对地完成批量薪酬支付。"));
  }

  if (features.vehicleTxns.length >= 2) {
    needs.push(need("NEED-TRAVEL", "车辆费用统一管理", 0.86, features.vehicleTxns.map((item) => item.txnId), "车辆相关支出连续出现，客户需要统一掌握车辆费用、减少零散报销并提升费用核对效率。"));
  }

  if (!needs.length) {
    needs.push(need("NEED-VERIFY", "待核实资金诉求", 0.62, pickEvidence(txns, "out", 2), `${customer.industry}客户已有持续收支活动，但现有数据不足以明确其资金安排痛点，需要通过拜访补充金额、频率和时点信息。`));
  }

  return needs;
}

function detectScenarios(customer: Customer, features: FeatureSet, txns: Transaction[], needs: FundNeed[]): Scenario[] {
  const scenarios: Scenario[] = [];

  if (features.supplierTxns.length >= 3) {
    scenarios.push(scenario("SCN-SUPPLIER-PAY", "供应商付款场景", "NEED-PAYMENT-EFFICIENCY", 0.91, features.supplierTxns, "固定供应商、周期付款、摘要含货款/采购/服务费"));
  }
  if (features.avgBalance90d > 4500000) {
    scenarios.push(scenario("SCN-IDLE-CASH", "闲置资金沉淀场景", "NEED-IDLE-CASH", 0.87, pickRows(txns, 4), "余额持续高位，销售回款后沉淀明显"));
  }
  if (features.vehicleTxns.length >= 2) {
    scenarios.push(scenario("SCN-VEHICLE", "车辆出行场景", "NEED-TRAVEL", 0.9, features.vehicleTxns, "ETC、加油、维修等车辆支出高频出现"));
  }
  if (features.payrollTxns.length >= 2) {
    scenarios.push(scenario("SCN-PAYROLL", "代发工资场景", "NEED-PAYROLL", 0.86, features.payrollTxns, "固定日期出现工资薪酬类付款"));
  }
  if (features.taxTxns.length >= 2) {
    scenarios.push(scenario("SCN-TAX", "税费社保缴纳场景", "NEED-PAYROLL", 0.8, features.taxTxns, "税务、社保等机构类缴费较稳定"));
  }
  if (features.collectTxns.length >= 2) {
    scenarios.push(scenario("SCN-COLLECT", "门店收款场景", "NEED-COLLECT", 0.84, features.collectTxns, "门店收款清算连续出现"));
  }
  if (features.transferTxns.length >= 2) {
    scenarios.push(scenario("SCN-CASH-POOL", "资金归集场景", "NEED-CASH-POOL", 0.82, features.transferTxns, "内部资金调拨和账户划转频繁"));
  }
  if (features.directTxns.length >= 4) {
    scenarios.push(scenario("SCN-DIRECT", "银企对接场景", "NEED-PAYMENT-EFFICIENCY", 0.78, features.directTxns, "高频银企直联交易和对账需求并存"));
  }

  if (!scenarios.length) {
    scenarios.push(scenario("SCN-VERIFY", "待核实经营场景", needs[0]?.needId ?? "NEED-VERIFY", 0.6, pickRows(txns, 3), "当前流水可见基础结算行为，需通过客户拜访补充场景"));
  }

  const primaryScenario = industryPrimaryScenario[customer.industry];
  return scenarios
    .map((item) =>
      item.scenarioName === primaryScenario
        ? { ...item, confidence: Math.max(item.confidence, 0.94) }
        : item,
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function matchProductBundles(scenarios: Scenario[], usageRows: ProductUsage[], products: Product[]): ProductBundle[] {
  return scenarios.map((scenarioItem) => {
    const productIds = bundleRules[scenarioItem.scenarioName] ?? ["PRD-EBANK"];
    const bundleProducts = productIds.map((id) => products.find((item) => item.productId === id)).filter((item): item is Product => Boolean(item));
    const missingProducts = bundleProducts.filter((item) => !usageRows.some((usageItem) => usageItem.productId === item.productId && usageItem.activated));
    return {
      scenarioId: scenarioItem.scenarioId,
      scenarioName: scenarioItem.scenarioName,
      bundleName: bundleProducts.map((item) => item.productName).join(" + "),
      products: bundleProducts,
      missingProducts,
      fitReason: `${scenarioItem.scenarioName}已命中，建议优先配置${bundleProducts.map((item) => item.productName).join("、")}，形成组合服务。`,
      verifyQuestion: buildVerifyQuestion(scenarioItem.scenarioName),
    };
  });
}

function diagnoseCoverage(scenarios: Scenario[], bundles: ProductBundle[], usageRows: ProductUsage[]): CoverageRow[] {
  return scenarios.map((scenarioItem) => {
    const bundle = bundles.find((item) => item.scenarioId === scenarioItem.scenarioId);
    if (!bundle) {
      return {
        scenarioName: scenarioItem.scenarioName,
        status: "未覆盖",
        signedCount: 0,
        totalCount: 0,
        missingProducts: [],
        description: "未找到匹配产品组合，需补充规则。",
      };
    }

    const signedCount = bundle.products.filter((productItem) => usageRows.some((usageItem) => usageItem.productId === productItem.productId && usageItem.signed)).length;
    const activatedCount = bundle.products.filter((productItem) => usageRows.some((usageItem) => usageItem.productId === productItem.productId && usageItem.activated)).length;
    const status = activatedCount === bundle.products.length ? "已覆盖" : signedCount > 0 || activatedCount > 0 ? "部分覆盖" : "未覆盖";

    return {
      scenarioName: scenarioItem.scenarioName,
      status,
      signedCount,
      totalCount: bundle.products.length,
      missingProducts: bundle.missingProducts.map((item) => item.productName),
      description: status === "已覆盖" ? "产品覆盖较完整，建议关注使用深度。" : `仍缺少 ${bundle.missingProducts.map((item) => item.productName).join("、")}。`,
    };
  });
}

function calculateValue(customer: Customer, features: FeatureSet, scenarios: Scenario[], coverage: CoverageRow[]): ValueResult {
  const depositBase = features.avgBalance90d > 4500000 ? Math.round(features.avgBalance90d * 0.16) : 180000;
  const txnBase = Math.round(sum(scenarios.flatMap((item) => item.evidenceRows), "amount") * 0.45);
  const firstGap = coverage.find((item) => item.status !== "已覆盖");
  return {
    valueId: `VAL-${customer.customerId.slice(-3)}`,
    customerId: customer.customerId,
    opportunityType: scenarios.map((item) => item.scenarioName).join(" / "),
    estimatedDepositIncrease: depositBase,
    estimatedTxnIncrease: Math.max(txnBase, 1200000),
    actionOwner: customer.managerName,
    nextAction: firstGap
      ? `围绕${firstGap.scenarioName}核实${firstGap.missingProducts.slice(0, 2).join("、")}配置条件。`
      : "复盘现有产品使用深度，推动交易留存和客户粘性提升。",
  };
}

function need(needId: string, needType: string, confidence: number, evidenceTxnIds: string[], explanation: string): FundNeed {
  return { needId, needType, confidence, evidenceTxnIds, explanation };
}

function scenario(scenarioId: string, scenarioName: string, triggerNeedId: string, confidence: number, evidenceRows: Transaction[], evidence: string): Scenario {
  return {
    scenarioId,
    scenarioName,
    triggerNeedId,
    confidence,
    evidence,
    evidenceTxnIds: evidenceRows.map((item) => item.txnId),
    evidenceRows,
  };
}

function buildVerifyQuestion(scenarioName: string): string {
  const questions: Record<string, string> = {
    供应商付款场景: "核实是否存在批量付款、审批流和自动对账痛点。",
    闲置资金沉淀场景: "核实未来 1-3 个月资金使用计划和资金留存周期。",
    车辆出行场景: "核实车辆数量、通行费规模和费用报销方式。",
    代发工资场景: "核实员工人数、发薪日期和是否希望联动个人账户服务。",
    税费社保缴纳场景: "核实税费社保缴纳周期和凭证归档方式。",
    门店收款场景: "核实门店数量、收款渠道和对账压力。",
    资金归集场景: "核实账户数量、项目资金管理模式和归集频率。",
    银企对接场景: "核实财务系统类型、接口能力和对账自动化诉求。",
  };
  return questions[scenarioName] ?? "核实客户真实经营场景和结算痛点。";
}

function pickEvidence(txns: Transaction[], direction: "in" | "out", count: number): string[] {
  return txns.filter((item) => item.direction === direction).slice(0, count).map((item) => item.txnId);
}

function pickRows(txns: Transaction[], count: number): Transaction[] {
  return txns.slice(0, count);
}

function assignVerificationStatus(txns: Transaction[]): Transaction[] {
  return txns.map((txn) => {
    if (txn.verificationStatus) return txn;
    const hasValidAmount = txn.amount > 0;
    const hasCounterparty = txn.counterpartyName && txn.counterpartyName !== "未知" && txn.counterpartyName !== "";
    const hasSummary = txn.summary && txn.summary !== "";
    const knownChannel = ["企业网银", "银企直联", "聚合收款", "代发工资", "柜台", "手机银行", "POS", "代扣"].includes(txn.channel);

    let status: import("../types").VerificationStatus;
    if (!hasValidAmount || !hasCounterparty || !hasSummary) {
      status = "suspicious";
    } else if (knownChannel && hasCounterparty && hasSummary) {
      status = "verified";
    } else {
      status = "pending";
    }
    return { ...txn, verificationStatus: status };
  });
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function sum<T>(rows: T[], key: keyof T): number {
  return rows.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}
