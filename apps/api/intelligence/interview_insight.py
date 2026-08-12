from __future__ import annotations

import json
import logging
import re
from typing import Any

from .model_client import ModelServiceClient
from .prompt_loader import build_system_prompt

LOGGER = logging.getLogger(__name__)

def summarize_interview_transcript(transcript: str, customer_name: str = "") -> dict[str, Any]:

    clean_text = transcript.strip()
    if not clean_text:
        raise ValueError("访谈转写文本为空，无法提炼资金需求。")

    client = ModelServiceClient()
    if not client.enabled:
        return _fallback_insight(clean_text, client.model)

    system_prompt = build_system_prompt(
        "customer_visit_minutes",
        {
            "customer": customer_name or "当前客户",
            "visit_text": clean_text,
            "analysis_context": "请以客户原话作为新增证据，不覆盖已有流水规则结论。",
        },
    )
    payload: dict[str, Any] = {
        "model": client.model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    "请只返回 JSON 对象，不要 Markdown。字段必须包含："
                    "needType、scenarioName、confidence、summary、evidenceQuote、"
                    "rationale、scenarioRationale、nextQuestion、recommendedProducts。confidence 为 0 到 1 的数字；"
                    "evidenceQuote 必须直接摘自客户原话；recommendedProducts 为字符串数组。"
                ),
            },
        ],
        "response_format": {"type": "json_object"},
    }
    if client.is_dashscope:
        payload["enable_thinking"] = False

    try:
        completion = client.chat_completions(payload)
        content = completion["choices"][0]["message"]["content"]
        parsed = _parse_json_object(content)
        return _normalize_insight(parsed, clean_text, completion.get("model") or client.model, "llm")
    except (KeyError, IndexError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        LOGGER.warning("GLM interview insight failed; using deterministic fallback: %s", error)
        return _fallback_insight(clean_text, client.model)

def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("模型未返回 JSON 对象。")
    return parsed

def _normalize_insight(payload: dict[str, Any], transcript: str, model: str, generated_by: str) -> dict[str, Any]:
    confidence = payload.get("confidence", 0.82)
    try:
        confidence = min(0.99, max(0.5, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.82
    products = payload.get("recommendedProducts", [])
    if not isinstance(products, list):
        products = [str(products)] if products else []
    return {
        "needId": "NEED-INTERVIEW-DISCOVERED",
        "needType": str(payload.get("needType") or "访谈补充资金需求"),
        "scenarioId": "SCN-INTERVIEW-DISCOVERED",
        "scenarioName": str(payload.get("scenarioName") or "访谈补充结算场景"),
        "confidence": confidence,
        "summary": str(payload.get("summary") or "客户在访谈中表达了需要进一步核实的资金安排诉求。"),
        "evidenceQuote": str(payload.get("evidenceQuote") or _pick_evidence_quote(transcript)),
        "rationale": str(payload.get("rationale") or "该判断来自客户访谈原话，需与账户流水进一步交叉验证。"),
        "scenarioRationale": str(payload.get("scenarioRationale") or "该经营场景由访谈中的资金安排方式推导，仍需结合实际交易进一步核验。"),
        "nextQuestion": str(payload.get("nextQuestion") or "请核实资金规模、发生频率和期望的办理时点。"),
        "recommendedProducts": [str(item) for item in products if str(item).strip()][:4],
        "sourceModel": model,
        "generatedBy": generated_by,
    }

def _fallback_insight(transcript: str, model: str) -> dict[str, Any]:
    joined = transcript.replace("\n", "")
    if re.search(r"校区|门店|账户.*分散|归集", joined):
        payload = {
            "needType": "多账户资金归集管理",
            "scenarioName": "多校区资金归集场景",
            "confidence": 0.9,
            "summary": "客户希望将分散在各校区账户的资金自动归集至总部，并为日常经营保留可控额度。",
            "evidenceQuote": _pick_evidence_quote(transcript, ("校区", "归集", "分散")),
            "rationale": "客户明确描述了多账户分散、手工归集和总部统筹资金的痛点。",
            "scenarioRationale": "客户描述了多个校区账户每日归集至总部的经营活动，因此可进一步评估多校区资金归集场景。",
            "nextQuestion": "请核实校区账户数量、每日归集时点、保留额度及总部审批规则。",
            "recommendedProducts": ["现金管理", "银企直联", "资金归集"],
        }
    elif re.search(r"闲置|增值|留存周期", joined):
        payload = {
            "needType": "短期闲置资金管理",
            "scenarioName": "闲置资金沉淀场景",
            "confidence": 0.86,
            "summary": "客户希望在不影响日常支出的前提下提升阶段性闲置资金收益。",
            "evidenceQuote": _pick_evidence_quote(transcript, ("闲置", "增值")),
            "rationale": "访谈中出现明确的资金留存周期和灵活增值诉求。",
            "scenarioRationale": "阶段性资金留存并希望兼顾灵活支用，构成闲置资金沉淀场景的业务线索。",
            "nextQuestion": "请核实未来三个月用款计划、最低留存金额和可接受期限。",
            "recommendedProducts": ["现金管理", "协定存款", "通知存款"],
        }
    else:
        payload = {
            "needType": "经营资金统筹",
            "scenarioName": "访谈补充经营场景",
            "confidence": 0.72,
            "summary": "客户表达了资金安排与结算效率诉求，建议结合账户流水继续核实。",
            "evidenceQuote": _pick_evidence_quote(transcript),
            "rationale": "访谈原话提供了流水之外的经营背景，但资金规模与频率仍需核实。",
            "scenarioRationale": "现有原话尚不足以锁定具体经营场景，需要补充资金发生方式与业务背景。",
            "nextQuestion": "请补充资金规模、发生频率、现有操作方式和希望改善的具体环节。",
            "recommendedProducts": [],
        }
    return _normalize_insight(payload, transcript, model, "local_fallback")

def _pick_evidence_quote(transcript: str, keywords: tuple[str, ...] = ()) -> str:
    sentences = [item.strip() for item in re.split(r"[。！？!?]", transcript) if item.strip()]
    selected = next((item for item in sentences if any(keyword in item for keyword in keywords)), None)
    selected = selected or (sentences[0] if sentences else transcript.strip())
    return selected[:120]
