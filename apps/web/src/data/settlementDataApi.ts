import type { SettlementDataset } from "../types";

const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:8787`;

export async function loadSettlementData(): Promise<SettlementDataset> {
  const response = await fetch(`${API_BASE_URL}/api/data/all`);
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail || `数据接口请求失败：${response.status}`);
  }
  return response.json();
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return payload?.detail?.message ?? payload?.error?.message ?? "";
  } catch {
    return "";
  }
}
