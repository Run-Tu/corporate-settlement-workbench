from __future__ import annotations

import base64
import json
import unittest

from apps.api.asr_service import (
    DEFAULT_MODEL,
    MAX_RAW_AUDIO_BYTES,
    DashScopeAsrClient,
    UploadedAudio,
    build_request_payload,
    validate_audio,
)

class FakeResponse:

    def __init__(self, payload: dict):
        self._body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return self._body

class AsrServiceTest(unittest.TestCase):
    def test_build_request_payload_embeds_local_audio_as_data_uri(self) -> None:
        audio = UploadedAudio("visit.mp3", "audio/mpeg", b"local-audio-bytes")

        payload = build_request_payload(audio)

        content = payload["input"]["messages"][0]["content"][0]
        expected = base64.b64encode(audio.content).decode("ascii")
        self.assertEqual(payload["model"], DEFAULT_MODEL)
        self.assertEqual(payload["parameters"], {"format": "mp3"})
        self.assertEqual(content["type"], "input_audio")
        self.assertEqual(content["input_audio"]["data"], f"data:audio/mpeg;base64,{expected}")

    def test_client_calls_api_host_and_normalizes_response(self) -> None:
        captured: dict = {}

        def fake_open(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse(
                {
                    "output": {
                        "text": "客户计划提升供应商付款效率。",
                        "sentence": {
                            "begin_time": 120,
                            "end_time": 2380,
                            "channel_id": 0,
                            "words": [{"text": "客户", "begin_time": 120, "end_time": 420}],
                        },
                    },
                    "usage": {"duration": 3},
                    "request_id": "req-asr-test",
                }
            )

        client = DashScopeAsrClient(
            api_key="test-key",
            api_host="llm-test.cn-beijing.maas.aliyuncs.com",
            opener=fake_open,
        )
        result = client.transcribe(UploadedAudio("visit.wav", "audio/wav", b"RIFF-test"))

        self.assertEqual(
            captured["url"],
            "https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        )
        self.assertEqual(captured["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(captured["headers"]["X-dashscope-sse"], "disable")
        self.assertEqual(captured["payload"]["parameters"]["format"], "wav")
        self.assertEqual(captured["timeout"], 180)
        self.assertEqual(result["source"], "aliyun_fun_asr_flash")
        self.assertEqual(result["text"], "客户计划提升供应商付款效率。")
        self.assertEqual(result["durationSeconds"], 3)
        self.assertEqual(result["requestId"], "req-asr-test")
        self.assertEqual(result["sentence"]["endTimeMs"], 2380)
        self.assertEqual(len(result["words"]), 1)

    def test_workspace_prefix_is_expanded_to_beijing_api_host(self) -> None:
        client = DashScopeAsrClient(api_key="test-key", api_host="llm-workspace-test")

        self.assertEqual(
            client.endpoint,
            "https://llm-workspace-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        )

    def test_validation_rejects_empty_unsupported_and_oversized_files(self) -> None:
        with self.assertRaisesRegex(ValueError, "音频格式"):
            validate_audio(UploadedAudio("visit.txt", "text/plain", b"text"))
        with self.assertRaisesRegex(ValueError, "文件为空"):
            validate_audio(UploadedAudio("visit.wav", "audio/wav", b""))
        with self.assertRaisesRegex(ValueError, "文件过大"):
            validate_audio(UploadedAudio("visit.wav", "audio/wav", b"0" * (MAX_RAW_AUDIO_BYTES + 1)))

    def test_empty_provider_transcription_is_reported_as_error(self) -> None:
        client = DashScopeAsrClient(
            api_key="test-key",
            api_host="llm-test.cn-beijing.maas.aliyuncs.com",
            opener=lambda request, timeout: FakeResponse({"output": {"text": ""}, "request_id": "req-empty"}),
        )

        with self.assertRaisesRegex(RuntimeError, "接口未返回识别文本"):
            client.transcribe(UploadedAudio("visit.wav", "audio/wav", b"RIFF-test"))

if __name__ == "__main__":
    unittest.main()
