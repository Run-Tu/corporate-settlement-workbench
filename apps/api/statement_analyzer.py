from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TEXTIN_PARSE_ENDPOINT = "https://api.textin.com/api/v1/xparse/parse/sync"
TEXTIN_EXTRACT_ENDPOINT = "https://api.textin.com/ai/service/v3/entity_extraction"
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf", ".bmp", ".tiff", ".tif", ".webp"}
@dataclass
class UploadedStatement:

    filename: str
    content_type: str
    content: bytes

class TextInClient:

    def __init__(self, app_id: str | None = None, secret_code: str | None = None):
        self.app_id = app_id if app_id is not None else os.getenv("TEXTIN_APP_ID", "")
        self.secret_code = secret_code if secret_code is not None else os.getenv("TEXTIN_SECRET_CODE", "")

    @property
    def enabled(self) -> bool:
        return bool(self.app_id and self.secret_code)

    def parse(self, statement: UploadedStatement) -> dict[str, Any]:
        boundary = f"----settlement-xparse-{uuid.uuid4().hex}"
        config = {
            "capabilities": {
                "include_table_structure": True,
                "title_tree": True,
            },
            "config": {
                "force_engine": "textin",
                "engine_params": {
                    "parse_mode": "scan",
                    "formula_level": 0,
                    "image_output_type": "url",
                },
            },
        }
        body = build_multipart_body(
            boundary,
            fields={"config": json.dumps(config, ensure_ascii=False)},
            files={
                "file": {
                    "filename": statement.filename,
                    "content_type": statement.content_type or "application/octet-stream",
                    "content": statement.content,
                }
            },
        )
        request = urllib.request.Request(
            TEXTIN_PARSE_ENDPOINT,
            data=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "x-ti-app-id": self.app_id,
                "x-ti-secret-code": self.secret_code,
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))
                ensure_textin_success(payload, "xParse")
                return payload
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"TextIn xParse error {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"TextIn xParse network error: {error.reason}") from error

    def extract(self, statement: UploadedStatement) -> dict[str, Any]:
        payload = {
            "file": {
                "file_base64": base64.b64encode(statement.content).decode("ascii"),
                "file_name": statement.filename,
            },
            "schema": bank_statement_schema(),
            "parse_options": {
                "page_start": 1,
                "page_count": 100,
                "get_image": "objects",
                "crop_dewarp": 0,
                "remove_watermark": 0,
                "parse_mode": "scan",
                "formula_level": 0,
                "table_flavor": "html",
            },
            "extract_options": {
                "generate_citations": True,
                "stamp": False,
            },
        }
        request = urllib.request.Request(
            TEXTIN_EXTRACT_ENDPOINT,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-ti-app-id": self.app_id,
                "x-ti-secret-code": self.secret_code,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = json.loads(response.read().decode("utf-8"))
                ensure_textin_success(result, "智能文档抽取")
                return result
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"TextIn extraction error {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"TextIn extraction network error: {error.reason}") from error

def build_statement_analysis(statement: UploadedStatement, customer_name: str = "") -> dict[str, Any]:

    validate_statement(statement)
    client = TextInClient()
    if client.enabled:
        parse_raw = client.parse(statement)
        extract_raw = client.extract(statement)
        return build_textin_statement_analysis(statement, parse_raw, extract_raw, customer_name)
    return build_stub_statement_analysis(statement, customer_name)

def validate_statement(statement: UploadedStatement) -> None:
    filename = statement.filename or "statement"
    extension = os.path.splitext(filename.lower())[1]
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError("仅支持 png、jpg、jpeg、pdf、bmp、tiff、webp 格式的流水影像。")
    if not statement.content:
        raise ValueError("上传文件为空。")
    if len(statement.content) > 50 * 1024 * 1024:
        raise ValueError("文件超过 TextIn 智能文档抽取 50MB 限制。")

def build_textin_statement_analysis(
    statement: UploadedStatement,
    parse_raw: dict[str, Any],
    extract_raw: dict[str, Any],
    customer_name: str,
) -> dict[str, Any]:
    parse_data = parse_raw.get("data") or {}
    extract_result = extract_raw.get("result") or {}
    extracted_schema = extract_result.get("extracted_schema") or {}
    rows = normalize_extracted_transactions(extracted_schema.get("流水条目") or [])
    total_in = sum(row["amount"] for row in rows if row["direction"] == "in")
    total_out = sum(row["amount"] for row in rows if row["direction"] == "out")
    top_counterparties = build_top_counterparties(rows)
    conclusions = build_conclusions(rows, total_in, total_out, top_counterparties)
    return {
        "fileName": statement.filename,
        "customerName": customer_name,
        "source": "textin_xparse_extract_v3",
        "parsedAt": int(time.time()),
        "recognition": {
            "schemaVersion": parse_data.get("schema_version"),
            "fileId": parse_data.get("file_id"),
            "jobId": parse_data.get("job_id"),
            "successCount": parse_data.get("success_count"),
            "metadata": parse_data.get("metadata") or {},
            "markdown": parse_data.get("markdown") or collect_text_from_elements(parse_data.get("elements", [])),
            "elements": parse_data.get("elements") or [],
            "titleTree": parse_data.get("title_tree") or [],
            "durationMs": (parse_data.get("summary") or {}).get("duration_ms"),
        },
        "extraction": {
            "status": extract_raw.get("status"),
            "version": extract_raw.get("version"),
            "requestId": extract_raw.get("x_request_id"),
            "durationMs": extract_raw.get("duration"),
            "schema": extracted_schema,
            "citations": extract_result.get("citations") or {},
            "pages": extract_result.get("pages") or [],
        },
        "summary": {
            "transactionCount": len(rows),
            "incomeTotal": total_in,
            "outcomeTotal": total_out,
            "netCashFlow": total_in - total_out,
            "topCounterparties": top_counterparties,
        },
        "transactions": rows,
        "conclusions": conclusions,
    }

def build_stub_statement_analysis(statement: UploadedStatement, customer_name: str) -> dict[str, Any]:
    sample_rows = [
        {"date": "2026-05-06", "direction": "in", "amount": 1280000, "balanceAfter": 7700000, "counterparty": "核心经销商回款", "summary": "货款回笼", "channel": "银企直联"},
        {"date": "2026-05-12", "direction": "out", "amount": 860000, "balanceAfter": 6840000, "counterparty": "上游供应商", "summary": "采购付款", "channel": "企业网银"},
        {"date": "2026-05-18", "direction": "out", "amount": 420000, "balanceAfter": 6420000, "counterparty": "物流服务商", "summary": "运输结算", "channel": "企业网银"},
        {"date": "2026-05-28", "direction": "in", "amount": 930000, "balanceAfter": 7350000, "counterparty": "平台渠道", "summary": "批量收款", "channel": "银企直联"},
    ]
    rows = [{**row, "id": f"stub-row-{index + 1}", "sourceLine": index + 2} for index, row in enumerate(sample_rows)]
    total_in = sum(row["amount"] for row in rows if row["direction"] == "in")
    total_out = sum(row["amount"] for row in rows if row["direction"] == "out")
    top_counterparties = build_top_counterparties(rows)
    return {
        "fileName": statement.filename,
        "customerName": customer_name,
        "source": "local_stub",
        "parsedAt": int(time.time()),
        "recognition": {
            "schemaVersion": "stub",
            "fileId": "",
            "jobId": "",
            "successCount": 1,
            "metadata": {"filename": statement.filename, "filetype": statement.content_type},
            "markdown": "|交易日期|收支方向|交易金额|账户余额|对方户名|摘要|渠道|\n" + "\n".join(
                f"|{row['date']}|{'收入' if row['direction'] == 'in' else '支出'}|{row['amount']}|{row['balanceAfter']}|{row['counterparty']}|{row['summary']}|{row['channel']}|"
                for row in rows
            ),
            "elements": [],
            "titleTree": [],
            "durationMs": 0,
        },
        "extraction": {
            "status": "stub",
            "version": "local",
            "requestId": "",
            "durationMs": 0,
            "schema": {
                "账户名称": customer_name,
                "流水条目": [
                    {
                        "交易日期": row["date"],
                        "收支方向": "收入" if row["direction"] == "in" else "支出",
                        "交易金额": row["amount"],
                        "账户余额": row["balanceAfter"],
                        "对方户名": row["counterparty"],
                        "摘要": row["summary"],
                        "渠道": row["channel"],
                    }
                    for row in rows
                ],
            },
            "citations": {},
            "pages": [],
        },
        "summary": {
            "transactionCount": len(rows),
            "incomeTotal": total_in,
            "outcomeTotal": total_out,
            "netCashFlow": total_in - total_out,
            "topCounterparties": top_counterparties,
        },
        "transactions": rows,
        "conclusions": build_conclusions(rows, total_in, total_out, top_counterparties),
    }

def bank_statement_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "required": ["账户名称", "账号", "查询期间", "期初余额", "期末余额", "流水条目"],
        "properties": {
            "账户名称": {"type": ["string", "null"], "description": "企业账户户名。"},
            "账号": {"type": ["string", "null"], "description": "企业银行账号，按原文保留脱敏星号。"},
            "查询期间": {"type": ["string", "null"], "description": "银行流水查询期间或交易明细期间。"},
            "期初余额": {"type": ["number", "null"], "description": "查询期间开始时的账户余额。"},
            "期末余额": {"type": ["number", "null"], "description": "查询期间结束时的账户余额。"},
            "流水条目": {
                "type": "array",
                "description": "逐行抽取交易明细表中的真实交易流水。不要抽取本期收入、本期支出、净流入、期初余额、期末余额等汇总项。",
                "items": {
                    "type": "object",
                    "required": ["交易日期", "收支方向", "交易金额", "账户余额", "对方户名", "摘要", "渠道"],
                    "properties": {
                        "交易日期": {"type": ["string", "null"], "description": "交易发生日期，格式尽量保持 YYYY-MM-DD。"},
                        "收支方向": {"type": ["string", "null"], "description": "收入或支出。"},
                        "交易金额": {"type": ["number", "null"], "description": "该笔交易发生额，只抽取交易金额列，不要抽取账户余额列。"},
                        "账户余额": {"type": ["number", "null"], "description": "该笔交易后的账户余额。"},
                        "对方户名": {"type": ["string", "null"], "description": "交易对手名称或对方账户户名。"},
                        "摘要": {"type": ["string", "null"], "description": "交易摘要、用途或附言。"},
                        "渠道": {"type": ["string", "null"], "description": "交易渠道，如企业网银、银企直联、批量付款等。"},
                    },
                },
            },
        },
    }

def ensure_textin_success(payload: dict[str, Any], label: str) -> None:
    status = payload.get("status")
    code = payload.get("code")
    message = str(payload.get("message") or payload.get("msg") or "")
    if status in (None, "success") and code in (None, 200):
        return
    if message.lower() == "success":
        return
    message = message or "unknown error"
    raise RuntimeError(f"TextIn {label} returned non-success response: {message}")

def normalize_extracted_transactions(items: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return rows
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        amount = parse_any_amount(item.get("交易金额"))
        if amount is None:
            continue
        direction_text = str(item.get("收支方向") or "")
        rows.append(
            {
                "id": f"extract-row-{index}",
                "date": str(item.get("交易日期") or "待识别"),
                "direction": normalize_direction(direction_text),
                "amount": amount,
                "balanceAfter": parse_any_amount(item.get("账户余额")),
                "counterparty": str(item.get("对方户名") or "待识别交易对手"),
                "summary": str(item.get("摘要") or ""),
                "channel": str(item.get("渠道") or ""),
                "sourceLine": index,
                "source": "extract_v3",
            }
        )
    return rows

def parse_any_amount(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return parse_amount(str(value or ""))

def normalize_direction(value: str) -> str:
    if re.search(r"收入|贷方|转入|回款|收款|入账|credit", value, re.IGNORECASE):
        return "in"
    return "out"

def extract_transaction_rows(markdown: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(markdown.splitlines(), start=1):
        normalized = re.sub(r"<[^>]+>", " ", line)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if not normalized:
            continue
        date_match = re.search(r"(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)", normalized)
        date = date_match.group(1).replace("年", "-").replace("月", "-").replace("日", "").replace("/", ".") if date_match else ""
        amount_text = re.sub(r"20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?", " ", normalized)
        amount_matches = re.findall(r"[-+]?\d[\d,]*(?:\.\d{1,2})?", amount_text)
        if not amount_matches:
            continue
        amount = float(amount_matches[-1].replace(",", ""))
        direction = "in" if re.search(r"收入|贷方|转入|回款|收款|入账", normalized) else "out"
        counterparty = extract_counterparty(normalized)
        rows.append(
            {
                "id": f"ocr-{index}",
                "date": date or "待识别",
                "direction": direction,
                "amount": amount,
                "counterparty": counterparty,
                "summary": normalized[:120],
                "sourceLine": index,
            }
        )
    return rows[:200]

def extract_textin_table_rows(raw: dict[str, Any]) -> list[dict[str, Any]]:
    elements = (raw.get("data") or {}).get("elements") or []
    rows: list[dict[str, Any]] = []
    for element in elements:
        structure = element.get("table_structure") or {}
        cells = structure.get("cells") or []
        if not cells:
            continue
        header_by_col = {cell.get("col"): normalize_cell(cell.get("text")) for cell in cells if cell.get("row") == 1}
        required = {"交易日期", "收支方向", "交易金额", "账户余额", "对方户名"}
        if not required.issubset(set(header_by_col.values())):
            continue
        col_by_header = {header: col for col, header in header_by_col.items()}
        row_numbers = sorted({cell.get("row") for cell in cells if isinstance(cell.get("row"), int) and cell.get("row") > 1})
        for row_number in row_numbers:
            row_cells = {cell.get("col"): normalize_cell(cell.get("text")) for cell in cells if cell.get("row") == row_number}
            amount = parse_amount(row_cells.get(col_by_header.get("交易金额"), ""))
            if amount is None:
                continue
            direction_text = row_cells.get(col_by_header.get("收支方向"), "")
            rows.append(
                {
                    "id": f"textin-row-{row_number - 1}",
                    "date": row_cells.get(col_by_header.get("交易日期"), "") or "待识别",
                    "direction": "in" if "收入" in direction_text else "out",
                    "amount": amount,
                    "balanceAfter": parse_amount(row_cells.get(col_by_header.get("账户余额"), "")),
                    "counterparty": row_cells.get(col_by_header.get("对方户名"), "") or "待识别交易对手",
                    "summary": row_cells.get(col_by_header.get("摘要"), ""),
                    "channel": row_cells.get(col_by_header.get("渠道"), ""),
                    "sourceLine": row_number,
                }
            )
    return rows

def normalize_cell(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()

def parse_amount(value: str) -> float | None:
    matches = re.findall(r"[-+]?\d[\d,]*(?:\.\d{1,2})?", value or "")
    if not matches:
        return None
    return float(matches[-1].replace(",", ""))

def extract_counterparty(text: str) -> str:
    cleaned = re.sub(r"20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?", "", text)
    cleaned = re.sub(r"[-+]?\d[\d,]*(?:\.\d{1,2})?", "", cleaned)
    tokens = [token for token in re.split(r"[|,，\s]+", cleaned) if token and token not in {"收入", "支出", "贷方", "借方"}]
    return tokens[0][:24] if tokens else "待识别交易对手"

def build_top_counterparties(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = row.get("counterparty") or "待识别交易对手"
        bucket = totals.setdefault(name, {"name": name, "amount": 0.0, "count": 0})
        bucket["amount"] += float(row.get("amount") or 0)
        bucket["count"] += 1
    return sorted(totals.values(), key=lambda item: item["amount"], reverse=True)[:5]

def build_conclusions(
    rows: list[dict[str, Any]],
    total_in: float,
    total_out: float,
    top_counterparties: list[dict[str, Any]],
) -> list[str]:
    conclusions = []
    if rows:
        conclusions.append(f"已识别 {len(rows)} 条候选流水，收入 {money(total_in)}，支出 {money(total_out)}。")
    else:
        conclusions.append("已完成文档解析，但暂未从文本中稳定抽取出流水行，建议查看 Markdown 原文并补充表格映射。")
    if total_out > total_in * 0.85 and total_out > 0:
        conclusions.append("付款压力接近或超过回款水平，资金需求侧更偏向短期头寸安排与付款节奏优化。")
    elif total_in > total_out * 1.2 and total_in > 0:
        conclusions.append("回款规模显著高于支出，存在沉淀资金管理与收款承接机会。")
    if top_counterparties:
        names = "、".join(item["name"] for item in top_counterparties[:3])
        conclusions.append(f"交易集中在 {names}，可作为场景核验与产品组合匹配的优先证据。")
    return conclusions

def collect_text_from_elements(elements: list[dict[str, Any]]) -> str:
    return "\n".join(str(item.get("text") or "") for item in elements if item.get("text"))

def build_multipart_body(boundary: str, fields: dict[str, str], files: dict[str, dict[str, Any]]) -> bytes:
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    for name, file_info in files.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{file_info["filename"]}"\r\n'
                ).encode("utf-8"),
                f'Content-Type: {file_info["content_type"]}\r\n\r\n'.encode("utf-8"),
                file_info["content"],
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks)

def money(value: float) -> str:
    if abs(value) >= 10000:
        return f"{round(value / 10000)} 万"
    return f"{round(value, 2)}"
