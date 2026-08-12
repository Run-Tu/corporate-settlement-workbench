import json
import os
import time
import urllib.error
import urllib.request
def _dashscope_base_url():
    host = os.getenv("DASHSCOPE_API_HOST", "").strip()
    if not host:
        return "https://dashscope.aliyuncs.com/compatible-mode/v1"
    host = host.removeprefix("https://").removeprefix("http://").rstrip("/")
    if host.startswith("llm-") and "." not in host:
        host = f"{host}.cn-beijing.maas.aliyuncs.com"
    return f"https://{host}/compatible-mode/v1"

_DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
DEFAULT_MODEL = os.getenv("DASHSCOPE_LLM_MODEL") or "glm-5.2"
DEFAULT_BASE_URL = _dashscope_base_url()

class ModelServiceClient:

    def __init__(self, api_key=None, base_url=None, model=None):
        self.api_key = api_key if api_key is not None else _DASHSCOPE_API_KEY
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.model = model or DEFAULT_MODEL

    @property
    def is_dashscope(self):

        return "aliyuncs.com" in self.base_url and ("maas" in self.base_url or "dashscope" in self.base_url)

    @property
    def enabled(self):

        return bool(self.api_key)

    def chat_completions(self, payload):

        request_payload = dict(payload)
        request_payload.setdefault("model", self.model)

        if not self.enabled:
            return build_stub_completion(request_payload)

        endpoint = f"{self.base_url}/chat/completions"
        data = json.dumps(request_payload).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"模型服务返回错误 {error.code}: {body}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"模型服务网络异常: {error.reason}") from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RuntimeError("模型服务返回了无法解析的响应。") from error

def build_stub_completion(payload):

    messages = payload.get("messages", [])
    last_user_message = next((item.get("content", "") for item in reversed(messages) if item.get("role") == "user"), "")
    content = "模型服务尚未配置，当前返回本地占位响应。"
    if last_user_message:
        content = f"{content}\n\n收到的问题：{last_user_message}"

    created = int(time.time())
    return {
        "id": f"chatcmpl-settlement-stub-{created}",
        "object": "chat.completion",
        "created": created,
        "model": payload.get("model", DEFAULT_MODEL),
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }
