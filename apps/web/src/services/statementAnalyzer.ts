const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:8787`;

export interface StatementTransaction {
  id?: string;
  date: string;
  direction: "in" | "out";
  amount: number;
  balanceAfter?: number | null;
  counterparty: string;
  summary: string;
  channel?: string;
  sourceLine?: number;
}

export interface StatementAnalysisResult {
  fileName: string;
  customerName: string;
  source: "textin_xparse_extract_v3" | "local_stub";
  parsedAt: number;
  recognition: {
    schemaVersion?: string;
    fileId?: string;
    jobId?: string;
    successCount?: number;
    metadata?: Record<string, unknown>;
    markdown: string;
    elements: Array<{
      element_id?: string;
      type?: string;
      text?: string;
      page_number?: number;
      table_structure?: unknown;
    }>;
    titleTree?: unknown[];
    durationMs?: number;
  };
  extraction: {
    status?: string;
    version?: string;
    requestId?: string;
    durationMs?: number;
    schema: Record<string, unknown>;
    citations: Record<string, unknown>;
    pages: unknown[];
  };
  summary: {
    transactionCount: number;
    incomeTotal: number;
    outcomeTotal: number;
    netCashFlow: number;
    topCounterparties: Array<{ name: string; amount: number; count: number }>;
  };
  transactions: StatementTransaction[];
  conclusions: string[];
}

export async function analyzeStatement(file: File, customerName: string): Promise<StatementAnalysisResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("customer_name", customerName);
  const response = await fetch(`${API_BASE_URL}/api/statements/analyze`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail?.message ?? `流水解析失败：${response.status}`);
  }
  return response.json();
}

export function answerStatementQuestion(question: string, result: StatementAnalysisResult): string {
  const normalized = question.trim();
  if (!normalized) return "";
  const { summary } = result;
  if (/收入|回款|流入/.test(normalized)) {
    return `识别到的收入合计为 ${formatMoney(summary.incomeTotal)}，共 ${result.transactions.filter((item) => item.direction === "in").length} 条候选流水。`;
  }
  if (/支出|付款|流出/.test(normalized)) {
    return `识别到的支出合计为 ${formatMoney(summary.outcomeTotal)}，共 ${result.transactions.filter((item) => item.direction === "out").length} 条候选流水。`;
  }
  if (/对手|客户|供应商|集中/.test(normalized)) {
    const top = summary.topCounterparties.slice(0, 3).map((item) => `${item.name}（${formatMoney(item.amount)}）`).join("、");
    return top ? `主要交易对手为 ${top}。建议结合原始影像核对名称归并和关联关系。` : "当前解析结果中暂未提取到稳定的交易对手信息。";
  }
  if (/资金需求|结论|建议|机会/.test(normalized)) {
    return result.conclusions.join("\n");
  }
  if (/净|缺口|余额/.test(normalized)) {
    const direction = summary.netCashFlow >= 0 ? "净流入" : "净流出";
    return `当前识别区间为${direction} ${formatMoney(Math.abs(summary.netCashFlow))}。该结果来自影像 OCR 抽取，进入授信或营销判断前建议进行人工复核。`;
  }
  return `这份流水共识别 ${summary.transactionCount} 条候选记录，收入 ${formatMoney(summary.incomeTotal)}，支出 ${formatMoney(summary.outcomeTotal)}。当前核心判断是：${result.conclusions[1] ?? result.conclusions[0]}`;
}

function formatMoney(value: number): string {
  return value >= 10000 ? `${Math.round(value / 10000)} 万元` : `${value.toLocaleString("zh-CN")} 元`;
}
