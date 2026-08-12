import type { CustomerAnalysis } from "../types";
import type { InterviewNeedInsight } from "./asr";

const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:8787`;

export interface ProjectAssistantAnswer {
  text: string;
  confidence: number;
  sources: string[];
}

export async function askProjectAssistant(
  question: string,
  analysis: CustomerAnalysis,
  activeStepId: string,
  promptKey: string,
  interviewInsight?: InterviewNeedInsight,
): Promise<ProjectAssistantAnswer> {
  const response = await fetch(`${API_BASE_URL}/api/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      promptKey,
      temperature: 0.25,
      variables: {
        question,
        active_step: activeStepId,
        customer: analysis.customer,
        customer_context: {
          customer: analysis.customer,
          accounts: analysis.accounts,
          features: analysis.features,
          interview_insight: interviewInsight ?? null,
        },
        fund_needs: analysis.needs,
        scenarios: analysis.scenarios,
        scenario: analysis.scenarios[0],
        product_bundles: analysis.bundles,
        product_bundle: analysis.bundles[0],
        recommended_products: analysis.bundles.flatMap((item) => item.products.map((product) => product.productName)),
        product_usage: analysis.usages,
        coverage: analysis.coverage,
        value_result: analysis.value,
        next_action: analysis.value.nextAction,
        interview_insight: interviewInsight ?? null,
      },
      messages: [{ role: "user", content: question }],
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail?.message ?? `智能问答失败：${response.status}`);
  }
  const payload = await response.json();
  if (String(payload.id || "").includes("settlement-stub")) {
    throw new Error("GLM-5.2 尚未配置。 ");
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("GLM-5.2 未返回回答。");
  return {
    text: String(text).trim(),
    confidence: 0.82,
    sources: [
      `大模型：${payload.model || "glm-5.2"}`,
      interviewInsight ? "当前客户结构化分析与访谈证据" : "当前客户结构化分析上下文",
    ],
  };
}
