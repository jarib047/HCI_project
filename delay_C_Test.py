from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import anyio
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from filelock import FileLock
from pydantic import BaseModel, Field

try:
    from google import genai
    from google.genai import types
except ImportError:  # pragma: no cover - handled at runtime for missing deps
    genai = None
    types = None


load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
SYSTEM_PROMPT = os.getenv(
    "GEMINI_SYSTEM_PROMPT",
    "You are a helpful assistant in a research chatbot. Respond clearly and naturally.",
)


def build_gemini_client():
    if genai is None or not GEMINI_API_KEY:
        return None
    return genai.Client(api_key=GEMINI_API_KEY)


gemini_client = build_gemini_client()

# FastAPI app setup
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# Local log setup
LOG_ROOT = Path("/tmp/chat_logs") if os.getenv("RENDER") else Path("logs")
CHAT_LOG_DIR = LOG_ROOT / "chat"
CLIENT_LOG_DIR = LOG_ROOT / "client"
CHAT_LOG_DIR.mkdir(parents=True, exist_ok=True)
CLIENT_LOG_DIR.mkdir(parents=True, exist_ok=True)


CHAT_HEADER = [
    "Timestamp",
    "ParticipantID",
    "QuestionID",
    "DelayCondition",
    "PromptText",
    "GeminiReply",
    "ActualLatency",
    "LatencyExceeded",
    "TaskCondition",
]

CLIENT_HEADER = [
    "Timestamp",
    "ParticipantID",
    "QuestionID",
    "DelayCondition",
    "TaskCondition",
    "EventType",
    "EventTarget",
    "Content",
    "LatencyFT",
    "LatencyLT",
]


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    conversation_history: list[Message] = Field(default_factory=list)
    delay: float = 1.0
    pid: str = "unknown"
    qid: str = "unspecified"
    task_condition: str = "unknown"
    start_time_s: float = 0.0


class ClientLogRequest(BaseModel):
    timestamp: str
    pid: str
    qid: str
    delay_condition: float
    task_condition: str
    type: str
    target: str = ""
    content: str = ""
    latency_ft: float = 0.0
    latency_lt: float = 0.0


@app.on_event("startup")
async def startup_event():
    if genai is None:
        print("WARNING: google-genai is not installed. Gemini routes will not work.")
    if not GEMINI_API_KEY:
        print("WARNING: GEMINI_API_KEY or GOOGLE_API_KEY is not set.")
    else:
        print(f"Gemini client configured with model: {GEMINI_MODEL}")


@app.get("/", response_class=HTMLResponse)
async def serve_index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


def safe_csv_field(field_value):
    if isinstance(field_value, str) and field_value and field_value[0] in "=+-@'\"":
        return "'" + field_value
    return field_value


def normalize_role(role: str) -> str:
    role_map = {
        "assistant": "model",
        "model": "model",
        "user": "user",
    }
    return role_map.get(role, "user")


def build_gemini_contents(history: list[Message], message: str) -> list[dict]:
    contents = []
    for item in history:
        text = (item.content or "").strip()
        if not text:
            continue
        contents.append(
            {
                "role": normalize_role(item.role),
                "parts": [{"text": text}],
            }
        )

    contents.append({"role": "user", "parts": [{"text": message}]})
    return contents


def ensure_gemini_ready():
    if genai is None:
        raise RuntimeError("Missing dependency: install `google-genai` first.")
    if types is None:
        raise RuntimeError("Gemini config types are unavailable.")
    if not GEMINI_API_KEY:
        raise RuntimeError("Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY.")
    if gemini_client is None:
        raise RuntimeError("Gemini client could not be initialized.")


def sanitize_identifier(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value or "unknown")
    return cleaned.strip("._") or "unknown"


def get_chat_log_path_for_pid(pid: str) -> Path:
    safe_pid = sanitize_identifier(pid)
    return CHAT_LOG_DIR / f"participant_{safe_pid}.csv"


def get_client_log_path_for_pid(pid: str) -> Path:
    safe_pid = sanitize_identifier(pid)
    return CLIENT_LOG_DIR / f"participant_{safe_pid}.csv"


def write_csv_row(row: list, log_path: Path, header: list[str]):
    lock = FileLock(str(log_path) + ".lock")
    with lock:
        write_header = not log_path.exists()
        with log_path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            if write_header:
                writer.writerow(header)
            writer.writerow(row)


async def append_to_chat_csv(new_row: list, pid: str):
    log_path = get_chat_log_path_for_pid(pid)
    await anyio.to_thread.run_sync(write_csv_row, new_row, log_path, CHAT_HEADER)


async def append_to_client_csv(new_row: list, pid: str):
    log_path = get_client_log_path_for_pid(pid)
    await anyio.to_thread.run_sync(write_csv_row, new_row, log_path, CLIENT_HEADER)


async def log_chat_interaction(
    message: str,
    reply: str,
    model_time: float,
    delay_condition: float,
    pid: str,
    question: str,
    task_condition: str,
):
    latency_exceeded = "Yes" if model_time > delay_condition else "No"
    row = [
        datetime.now(timezone.utc).isoformat(),
        safe_csv_field(str(pid)),
        safe_csv_field(str(question)),
        delay_condition,
        safe_csv_field(message),
        safe_csv_field(reply),
        round(model_time, 3),
        latency_exceeded,
        safe_csv_field(task_condition),
    ]
    await append_to_chat_csv(row, pid)


def extract_text(response) -> str:
    text = getattr(response, "text", None)
    if text:
        return text
    return ""


def build_generation_kwargs(contents: list[dict]) -> dict:
    kwargs = {
        "model": GEMINI_MODEL,
        "contents": contents,
    }
    if SYSTEM_PROMPT:
        kwargs["config"] = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT
        )
    return kwargs


@app.post("/client-log")
async def handle_client_log(log: ClientLogRequest):
    try:
        row = [
            safe_csv_field(log.timestamp),
            safe_csv_field(str(log.pid)),
            safe_csv_field(str(log.qid)),
            log.delay_condition,
            safe_csv_field(str(log.task_condition)),
            safe_csv_field(str(log.type)),
            safe_csv_field(str(log.target)),
            safe_csv_field(str(log.content)),
            round(float(log.latency_ft or 0), 3),
            round(float(log.latency_lt or 0), 3),
        ]
        await append_to_client_csv(row, log.pid)
        return {"status": "ok"}
    except Exception as exc:
        print(f"Failed to handle client log: {exc}")
        return {"error": str(exc)}


@app.post("/chat-stream")
async def chat_stream(request: ChatRequest):
    try:
        ensure_gemini_ready()
    except Exception as exc:
        async def immediate_error():
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

        return StreamingResponse(immediate_error(), media_type="text/event-stream")

    start_time = time.perf_counter()
    contents = build_gemini_contents(request.conversation_history, request.message)

    async def generate():
        response_parts: list[str] = []
        first_chunk_sent = False

        try:
            stream = gemini_client.models.generate_content_stream(
                **build_generation_kwargs(contents)
            )

            for chunk in stream:
                chunk_text = extract_text(chunk)
                if not chunk_text:
                    continue

                response_parts.append(chunk_text)

                if not first_chunk_sent:
                    elapsed = time.perf_counter() - start_time
                    remaining_delay = max(request.delay - elapsed, 0)
                    if remaining_delay > 0:
                        await asyncio.sleep(remaining_delay)
                    first_chunk_sent = True

                yield (
                    f"data: {json.dumps({'content': chunk_text, 'type': 'content'})}\n\n"
                )

            # If the model returns no text, keep the stream contract intact.
            if not first_chunk_sent:
                elapsed = time.perf_counter() - start_time
                remaining_delay = max(request.delay - elapsed, 0)
                if remaining_delay > 0:
                    await asyncio.sleep(remaining_delay)

            total_elapsed = time.perf_counter() - start_time
            full_response = "".join(response_parts).strip()

            if full_response:
                await log_chat_interaction(
                    message=request.message,
                    reply=full_response,
                    model_time=total_elapsed,
                    delay_condition=request.delay,
                    pid=request.pid,
                    question=request.qid,
                    task_condition=request.task_condition,
                )

            yield (
                "data: "
                + json.dumps(
                    {
                        "type": "complete",
                        "gpt_time": round(total_elapsed, 3),
                        "manual_delay": round(max(request.delay - total_elapsed, 0), 3),
                    }
                )
                + "\n\n"
            )
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.post("/chat")
async def chat(request: ChatRequest):
    try:
        ensure_gemini_ready()
        start_time = time.perf_counter()
        contents = build_gemini_contents(request.conversation_history, request.message)

        response = await anyio.to_thread.run_sync(
            lambda: gemini_client.models.generate_content(
                **build_generation_kwargs(contents)
            )
        )

        reply = extract_text(response).strip()
        elapsed_time = time.perf_counter() - start_time
        remaining_delay = max(request.delay - elapsed_time, 0)
        if remaining_delay > 0:
            await asyncio.sleep(remaining_delay)

        await log_chat_interaction(
            message=request.message,
            reply=reply,
            model_time=elapsed_time,
            delay_condition=request.delay,
            pid=request.pid,
            question=request.qid,
            task_condition=request.task_condition,
        )

        return {
            "response": reply,
            "gpt_time": round(elapsed_time, 3),
            "manual_delay": round(remaining_delay, 3),
        }
    except Exception as exc:
        return {"error": str(exc)}


@app.get("/download-log/{pid}")
async def download_participant_log(pid: str):
    log_path = get_chat_log_path_for_pid(pid)
    if not log_path.exists():
        return {"error": f"No chat log file found for participant {pid}"}

    return FileResponse(
        path=log_path,
        media_type="text/csv",
        filename=f"participant_{sanitize_identifier(pid)}_chat_log.csv",
    )


def combined_chat_csv_bytes():
    files = sorted(CHAT_LOG_DIR.glob("participant_*.csv"))
    if not files:
        yield b"No data found\n"
        return

    header_written = False
    for path in files:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            rows = list(reader)

        if not rows:
            continue

        if not header_written:
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(rows[0])
            yield output.getvalue().encode("utf-8")
            header_written = True

        for row in rows[1:]:
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(row)
            yield output.getvalue().encode("utf-8")


@app.get("/download-all-logs")
async def download_all_logs(api_key: Optional[str] = None):
    required_api_key = os.getenv("DOWNLOAD_API_KEY")
    if not required_api_key:
        return {"error": "Download functionality not configured"}

    if not api_key or api_key != required_api_key:
        return {"error": "Unauthorized: Invalid or missing API key"}

    return StreamingResponse(
        combined_chat_csv_bytes(),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=all_participants_chat_logs.csv"
        },
    )
