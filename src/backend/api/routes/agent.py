"""POST /agent/chat -> SSE stream (Backend_Handoff §6/§7, step 8)."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.runner import format_sse, run_agent_turn

router = APIRouter(tags=["agent"])


class ChatRequest(BaseModel):
    message: str


@router.post("/agent/chat")
async def agent_chat(req: ChatRequest) -> StreamingResponse:
    async def event_stream():
        async for event in run_agent_turn(req.message):
            yield format_sse(event)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
