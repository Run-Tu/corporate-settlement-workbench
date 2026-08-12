from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from apps.api.intelligence.interview_insight import summarize_interview_transcript

TRANSCRIPT = (
    "我们有十二个校区，各校区账户资金比较分散，财务每天都要手工归集。"
    "希望银行把各校区资金自动归集到总部，同时保留日常支出额度。"
)

class FakeDisabledClient:
    enabled = False
    model = "glm-5.2"

class FakeGlmClient:
    enabled = True
    model = "glm-5.2"
    is_dashscope = True

    def chat_completions(self, payload):
        assert payload["enable_thinking"] is False
        return {
            "model": "glm-5.2",
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "needType": "多账户资金归集管理",
                                "scenarioName": "多校区资金归集场景",
                                "confidence": 0.93,
                                "summary": "客户希望总部统一管理校区资金。",
                                "evidenceQuote": "各校区账户资金比较分散",
                                "rationale": "存在手工归集痛点。",
                                "scenarioRationale": "多个校区每日向总部归集资金，符合资金归集经营活动。",
                                "nextQuestion": "请核实归集时点与留存额度。",
                                "recommendedProducts": ["现金管理", "银企直联"],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ],
        }

class InterviewInsightTest(unittest.TestCase):
    @patch("apps.api.intelligence.interview_insight.ModelServiceClient", return_value=FakeGlmClient())
    def test_glm_result_is_normalized(self, _mock_client) -> None:
        insight = summarize_interview_transcript(TRANSCRIPT, "启明星教育培训集团有限公司")

        self.assertEqual(insight["needType"], "多账户资金归集管理")
        self.assertEqual(insight["scenarioName"], "多校区资金归集场景")
        self.assertEqual(insight["generatedBy"], "llm")
        self.assertIn("资金归集", insight["scenarioRationale"])
        self.assertEqual(insight["sourceModel"], "glm-5.2")
        self.assertAlmostEqual(insight["confidence"], 0.93)

    @patch("apps.api.intelligence.interview_insight.ModelServiceClient", return_value=FakeDisabledClient())
    def test_rule_fallback_keeps_demo_available(self, _mock_client) -> None:
        insight = summarize_interview_transcript(TRANSCRIPT)

        self.assertEqual(insight["scenarioName"], "多校区资金归集场景")
        self.assertEqual(insight["generatedBy"], "local_fallback")
        self.assertIn("归集", insight["evidenceQuote"])

if __name__ == "__main__":
    unittest.main()
