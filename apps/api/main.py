from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

try:
    from .intelligence.model_client import ModelServiceClient
    from .intelligence.interview_insight import summarize_interview_transcript
    from .intelligence.prompt_loader import PromptNotFoundError, build_system_prompt, list_prompt_keys
    from .asr_service import UploadedAudio, transcribe_uploaded_audio
    from .db import SettlementRepository
    from .statement_analyzer import UploadedStatement, build_statement_analysis
except ImportError:

    from intelligence.model_client import ModelServiceClient
    from intelligence.interview_insight import summarize_interview_transcript
    from intelligence.prompt_loader import PromptNotFoundError, build_system_prompt, list_prompt_keys
    from asr_service import UploadedAudio, transcribe_uploaded_audio
    from db import SettlementRepository
    from statement_analyzer import UploadedStatement, build_statement_analysis

HOST = "127.0.0.1"
PORT = 8787
DEMO_INTERVIEW_AUDIO = Path(__file__).resolve().parent / "tests" / "fixtures" / "customer-fund-needs-demo.mp3"

app = FastAPI(
    title="Settlement Demo API",
    description="Settlement business cockpit service.",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check() -> dict[str, str]:

    return {"status": "ok", "service": "settlement-demo-api"}

@app.get("/api/prompts")
def get_prompts() -> dict[str, list[str]]:

    return {"prompts": list_prompt_keys()}

@app.get("/api/data/all")
def get_all_data() -> dict[str, Any]:

    try:
        return SettlementRepository().get_all_data()
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail={"message": str(error), "type": "database_not_initialized"}) from error

@app.post("/api/statements/analyze")
async def analyze_bank_statement(
    file: UploadFile = File(...),
    customer_name: str = Form(default=""),
) -> dict[str, Any]:

    try:
        content = await file.read()
        return build_statement_analysis(
            UploadedStatement(
                filename=file.filename or "statement",
                content_type=file.content_type or "application/octet-stream",
                content=content,
            ),
            customer_name=customer_name,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail={"message": str(error), "type": "invalid_statement"}) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail={"message": str(error), "type": "textin_provider_error"}) from error

@app.post("/api/asr/transcribe")
async def transcribe_customer_audio(
    file: UploadFile = File(...),
    customer_name: str = Form(default=""),
) -> dict[str, Any]:

    try:
        content = await file.read()
        result = transcribe_uploaded_audio(
            UploadedAudio(
                filename=file.filename or "customer-interview",
                content_type=file.content_type or "application/octet-stream",
                content=content,
            )
        )
        result["insight"] = summarize_interview_transcript(result["text"], customer_name)
        return result
    except ValueError as error:
        raise HTTPException(status_code=400, detail={"message": str(error), "type": "invalid_audio"}) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail={"message": str(error), "type": "asr_provider_error"}) from error

@app.get("/api/asr/demo-audio")
def get_demo_interview_audio() -> FileResponse:

    if not DEMO_INTERVIEW_AUDIO.exists():
        raise HTTPException(status_code=404, detail={"message": "演示录音尚未生成。", "type": "demo_audio_missing"})
    return FileResponse(
        DEMO_INTERVIEW_AUDIO,
        media_type="audio/mpeg",
        filename=DEMO_INTERVIEW_AUDIO.name,
    )

@app.post("/v1/chat/completions")
def chat_completions(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:

    try:
        return ModelServiceClient().chat_completions(payload)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail={"message": str(error), "type": "provider_error"}) from error

@app.post("/api/assistant/chat")
def assistant_chat(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:

    prompt_key = payload.get("promptKey")
    variables = payload.get("variables", {})
    messages = payload.get("messages", [])
    model = payload.get("model")
    temperature = payload.get("temperature", 0.3)

    try:
        system_prompt = build_system_prompt(prompt_key, variables)
        client = ModelServiceClient(model=model)
        completion_payload = {
            "model": model or client.model,
            "temperature": temperature,
            "max_tokens": 900,
            "messages": [
                {"role": "system", "content": system_prompt},
                *messages,
            ],
        }
        if client.is_dashscope:
            completion_payload["enable_thinking"] = False
        completion = client.chat_completions(completion_payload)
    except PromptNotFoundError as error:
        raise HTTPException(status_code=400, detail={"message": str(error), "type": "invalid_prompt"}) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail={"message": str(error), "type": "provider_error"}) from error

    completion["promptKey"] = prompt_key
    return completion

def run() -> None:

    uvicorn.run("apps.api.main:app", host=HOST, port=PORT, reload=False)

if __name__ == "__main__":
    run()
