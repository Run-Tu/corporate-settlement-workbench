from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

DEFAULT_MODEL = "fun-asr-flash-2026-06-15"
DEFAULT_API_HOST = "dashscope.aliyuncs.com"

MAX_RAW_AUDIO_BYTES = 7 * 1024 * 1024
SUPPORTED_AUDIO_FORMATS: dict[str, tuple[str, str]] = {
    ".aac": ("aac", "audio/aac"),
    ".flac": ("flac", "audio/flac"),
    ".m4a": ("m4a", "audio/mp4"),
    ".mp3": ("mp3", "audio/mpeg"),
    ".ogg": ("ogg", "audio/ogg"),
    ".opus": ("opus", "audio/opus"),
    ".wav": ("wav", "audio/wav"),
    ".webm": ("webm", "audio/webm"),
}

@dataclass(frozen=True)
class UploadedAudio:

    filename: str
    content_type: str
    content: bytes

class DashScopeAsrClient:

    def __init__(
        self,
        api_key: str | None = None,
        api_host: str | None = None,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else os.getenv("DASHSCOPE_API_KEY", "")
        configured_host = api_host if api_host is not None else os.getenv("DASHSCOPE_API_HOST", "")
        self.api_host = normalize_api_host(configured_host or DEFAULT_API_HOST)
        self.model = DEFAULT_MODEL
        self._opener = opener or urllib.request.urlopen

    @property
    def enabled(self) -> bool:

        return bool(self.api_key)

    @property
    def endpoint(self) -> str:

        return f"https://{self.api_host}/api/v1/services/aigc/multimodal-generation/generation"

    def transcribe(self, audio: UploadedAudio, timeout: int = 180) -> dict[str, Any]:

        validate_audio(audio)
        if not self.api_key:
            raise RuntimeError("未配置 DASHSCOPE_API_KEY。")

        payload = build_request_payload(audio, self.model)
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "X-DashScope-SSE": "disable",
            },
            method="POST",
        )

        try:
            with self._opener(request, timeout=timeout) as response:
                provider_payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Fun-ASR 接口返回 HTTP {error.code}：{detail}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Fun-ASR 网络请求失败：{error.reason}") from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RuntimeError("Fun-ASR 返回了无法解析的响应。") from error

        return normalize_provider_response(audio, self.model, provider_payload)

def transcribe_uploaded_audio(audio: UploadedAudio) -> dict[str, Any]:

    client = DashScopeAsrClient()
    if not client.enabled:
        raise RuntimeError("ASR 尚未配置，请设置 DASHSCOPE_API_KEY。")
    return client.transcribe(audio)

def normalize_api_host(value: str) -> str:

    host = value.strip()
    if host.startswith("https://"):
        host = host.removeprefix("https://")
    elif host.startswith("http://"):
        host = host.removeprefix("http://")
    host = host.rstrip("/")
    if host.startswith("llm-") and "." not in host:
        host = f"{host}.cn-beijing.maas.aliyuncs.com"
    if not host or "/" in host:
        raise ValueError("DASHSCOPE_API_HOST 只应填写域名，不要包含 /api/v1 等路径。")
    return host

def validate_audio(audio: UploadedAudio) -> None:

    extension = Path(audio.filename or "audio").suffix.lower()
    if extension not in SUPPORTED_AUDIO_FORMATS:
        supported = "、".join(item.removeprefix(".") for item in SUPPORTED_AUDIO_FORMATS)
        raise ValueError(f"不支持该音频格式，当前支持 {supported}。")
    if not audio.content:
        raise ValueError("上传的音频文件为空。")
    if len(audio.content) > MAX_RAW_AUDIO_BYTES:
        raise ValueError("音频文件过大；同步演示模式要求原始文件不超过 7MB、时长不超过 5 分钟。")

def build_request_payload(audio: UploadedAudio, model: str = DEFAULT_MODEL) -> dict[str, Any]:

    validate_audio(audio)
    extension = Path(audio.filename).suffix.lower()
    audio_format, default_mime = SUPPORTED_AUDIO_FORMATS[extension]
    mime_type = audio.content_type if audio.content_type.startswith("audio/") else default_mime
    encoded = base64.b64encode(audio.content).decode("ascii")
    data_uri = f"data:{mime_type};base64,{encoded}"
    return {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": data_uri},
                        }
                    ],
                }
            ]
        },
        "parameters": {"format": audio_format},
    }

def normalize_provider_response(audio: UploadedAudio, model: str, payload: dict[str, Any]) -> dict[str, Any]:

    output = payload.get("output") or {}
    text = output.get("text")
    if not isinstance(text, str) or not text.strip():
        code = payload.get("code") or output.get("code") or "empty_transcription"
        message = payload.get("message") or output.get("message") or "接口未返回识别文本"
        raise RuntimeError(f"Fun-ASR 识别失败（{code}）：{message}")

    sentence = output.get("sentence") or {}
    words = sentence.get("words") if isinstance(sentence, dict) else []
    usage = payload.get("usage") or {}
    return {
        "fileName": audio.filename,
        "source": "aliyun_fun_asr_flash",
        "model": model,
        "requestId": payload.get("request_id"),
        "text": text.strip(),
        "durationSeconds": usage.get("duration"),
        "sentence": {
            "beginTimeMs": sentence.get("begin_time"),
            "endTimeMs": sentence.get("end_time"),
            "channelId": sentence.get("channel_id"),
        },
        "words": words if isinstance(words, list) else [],
        "transcribedAt": int(time.time()),
    }
