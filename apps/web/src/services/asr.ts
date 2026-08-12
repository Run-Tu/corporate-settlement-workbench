const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:8787`;

export interface AsrWord {
  text?: string;
  begin_time?: number;
  end_time?: number;
  punctuation?: string;
  fixed?: boolean;
}

export interface AsrTranscriptionResult {
  fileName: string;
  source: "aliyun_fun_asr_flash";
  model: string;
  requestId?: string;
  text: string;
  durationSeconds?: number;
  sentence: {
    beginTimeMs?: number;
    endTimeMs?: number;
    channelId?: number;
  };
  words: AsrWord[];
  transcribedAt: number;
  insight: InterviewNeedInsight;
}

export interface InterviewNeedInsight {
  needId: string;
  needType: string;
  scenarioId: string;
  scenarioName: string;
  confidence: number;
  summary: string;
  evidenceQuote: string;
  rationale: string;
  scenarioRationale: string;
  nextQuestion: string;
  recommendedProducts: string[];
  sourceModel: string;
  generatedBy: "llm" | "local_fallback";
}

export async function transcribeAudio(file: File, customerName: string): Promise<AsrTranscriptionResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("customer_name", customerName);
  const response = await fetch(`${API_BASE_URL}/api/asr/transcribe`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail?.message ?? `音频识别失败：${response.status}`);
  }
  return response.json();
}

export async function loadDemoInterviewAudio(): Promise<File> {
  const response = await fetch(`${API_BASE_URL}/api/asr/demo-audio`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail?.message ?? `演示录音加载失败：${response.status}`);
  }
  const blob = await response.blob();
  return new File([blob], "customer-fund-needs-demo.mp3", { type: "audio/mpeg" });
}
