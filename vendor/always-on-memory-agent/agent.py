"""
Agent Memory Layer — Always-On OpenAI Agent

A lightweight, cost-effective background agent that continuously processes,
consolidates, and serves memory. Runs 24/7 with an OpenAI-backed runtime that
preserves the original ADK-style multi-agent behavior.

Usage:
    python agent.py                          # watch ./inbox, serve on :8888
    python agent.py --watch ./docs --port 9000
    python agent.py --consolidate-every 15   # consolidate every 15 min

Query:
    curl "http://localhost:8888/query?q=what+do+you+know"
    curl -X POST http://localhost:8888/ingest -d '{"text": "some info"}'
"""

import argparse
import asyncio
import base64
import io
import json
import logging
import mimetypes
import os
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from aiohttp import web
from openai import OpenAI

# ─── Config ────────────────────────────────────────────────────

DEFAULT_MODEL = "gpt-4.1-mini"
DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
DB_PATH = os.getenv("MEMORY_DB", "memory.db")
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
MAX_VIDEO_FRAMES = int(os.getenv("MAX_VIDEO_FRAMES", "12"))
VIDEO_FRAME_INTERVAL_SECONDS = int(os.getenv("VIDEO_FRAME_INTERVAL_SECONDS", "10"))

# Supported file types for multimodal ingestion
TEXT_EXTENSIONS = {".txt", ".md", ".json", ".csv", ".log", ".xml", ".yaml", ".yml"}
MEDIA_EXTENSIONS = {
    # Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    # Audio
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    # Video
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    # Documents
    ".pdf": "application/pdf",
}
ALL_SUPPORTED = TEXT_EXTENSIONS | set(MEDIA_EXTENSIONS.keys())
AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="[%H:%M]",
)
log = logging.getLogger("memory-agent")


def _get_required_env(name: str, client_name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name} environment variable for {client_name}")
    return value


def _get_optional_env(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


@dataclass(frozen=True)
class OpenAIClientConfig:
    api_key: str
    base_url: str
    model: str


@dataclass(frozen=True)
class AppConfig:
    main: OpenAIClientConfig
    transcription: OpenAIClientConfig

    @classmethod
    def from_env(cls) -> "AppConfig":
        return cls(
            main=OpenAIClientConfig(
                api_key=_get_required_env("MEMORY_OPENAI_API_KEY", "main OpenAI client"),
                base_url=_get_required_env("MEMORY_OPENAI_BASE_URL", "main OpenAI client"),
                model=_get_optional_env("MODEL", DEFAULT_MODEL),
            ),
            transcription=OpenAIClientConfig(
                api_key=_get_required_env(
                    "TRANSCRIPTION_OPENAI_API_KEY",
                    "transcription OpenAI client",
                ),
                base_url=_get_required_env(
                    "TRANSCRIPTION_OPENAI_BASE_URL",
                    "transcription OpenAI client",
                ),
                model=_get_optional_env(
                    "TRANSCRIPTION_MODEL",
                    DEFAULT_TRANSCRIPTION_MODEL,
                ),
            ),
        )


def create_openai_client(config: OpenAIClientConfig) -> OpenAI:
    return OpenAI(api_key=config.api_key, base_url=config.base_url)


# ─── Lightweight Content Types ────────────────────────────────


@dataclass
class Part:
    kind: str
    text: str | None = None
    data: bytes | None = None
    mime_type: str | None = None
    filename: str | None = None

    @classmethod
    def from_text(cls, text: str) -> "Part":
        return cls(kind="text", text=text)

    @classmethod
    def from_bytes(
        cls,
        data: bytes,
        mime_type: str,
        filename: str | None = None,
    ) -> "Part":
        return cls(kind="bytes", data=data, mime_type=mime_type, filename=filename)


@dataclass
class Content:
    role: str
    parts: list[Part]


@dataclass
class Session:
    id: str
    app_name: str
    user_id: str
    history: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Event:
    content: Content | None = None


class InMemorySessionService:
    def __init__(self):
        self._sessions: dict[str, Session] = {}

    async def create_session(self, app_name: str, user_id: str) -> Session:
        session = Session(
            id=str(uuid.uuid4()),
            app_name=app_name,
            user_id=user_id,
        )
        self._sessions[session.id] = session
        return session

    async def get_session(self, session_id: str) -> Session:
        return self._sessions[session_id]


# ─── Database ──────────────────────────────────────────────────


def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL DEFAULT '',
            raw_text TEXT NOT NULL,
            summary TEXT NOT NULL,
            entities TEXT NOT NULL DEFAULT '[]',
            topics TEXT NOT NULL DEFAULT '[]',
            connections TEXT NOT NULL DEFAULT '[]',
            importance REAL NOT NULL DEFAULT 0.5,
            created_at TEXT NOT NULL,
            consolidated INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS consolidations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_ids TEXT NOT NULL,
            summary TEXT NOT NULL,
            insight TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processed_files (
            path TEXT PRIMARY KEY,
            processed_at TEXT NOT NULL
        );
    """)
    return db


# ─── Memory Tools ──────────────────────────────────────────────


def store_memory(
    raw_text: str,
    summary: str,
    entities: list[str],
    topics: list[str],
    importance: float,
    source: str = "",
) -> dict:
    """Store a processed memory in the database."""
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    cursor = db.execute(
        """INSERT INTO memories (source, raw_text, summary, entities, topics, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            source,
            raw_text,
            summary,
            json.dumps(entities),
            json.dumps(topics),
            importance,
            now,
        ),
    )
    db.commit()
    mid = cursor.lastrowid
    db.close()
    log.info(f"📥 Stored memory #{mid}: {summary[:60]}...")
    return {"memory_id": mid, "status": "stored", "summary": summary}


def read_all_memories() -> dict:
    """Read all stored memories from the database, most recent first."""
    db = get_db()
    rows = db.execute("SELECT * FROM memories ORDER BY created_at DESC LIMIT 50").fetchall()
    memories = []
    for r in rows:
        memories.append({
            "id": r["id"],
            "source": r["source"],
            "summary": r["summary"],
            "entities": json.loads(r["entities"]),
            "topics": json.loads(r["topics"]),
            "importance": r["importance"],
            "connections": json.loads(r["connections"]),
            "created_at": r["created_at"],
            "consolidated": bool(r["consolidated"]),
        })
    db.close()
    return {"memories": memories, "count": len(memories)}


def read_unconsolidated_memories() -> dict:
    """Read memories that haven't been consolidated yet."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM memories WHERE consolidated = 0 ORDER BY created_at DESC LIMIT 10"
    ).fetchall()
    memories = []
    for r in rows:
        memories.append({
            "id": r["id"],
            "summary": r["summary"],
            "entities": json.loads(r["entities"]),
            "topics": json.loads(r["topics"]),
            "importance": r["importance"],
            "created_at": r["created_at"],
        })
    db.close()
    return {"memories": memories, "count": len(memories)}


def store_consolidation(
    source_ids: list[int],
    summary: str,
    insight: str,
    connections: list[dict],
) -> dict:
    """Store a consolidation result and mark source memories as consolidated."""
    if not source_ids:
        return {"status": "skipped", "reason": "no_source_ids"}

    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        "INSERT INTO consolidations (source_ids, summary, insight, created_at) VALUES (?, ?, ?, ?)",
        (json.dumps(source_ids), summary, insight, now),
    )
    for conn in connections:
        from_id = conn.get("from_id")
        to_id = conn.get("to_id")
        rel = conn.get("relationship", "")
        if from_id and to_id:
            for mid in [from_id, to_id]:
                row = db.execute(
                    "SELECT connections FROM memories WHERE id = ?",
                    (mid,),
                ).fetchone()
                if row:
                    existing = json.loads(row["connections"])
                    existing.append({
                        "linked_to": to_id if mid == from_id else from_id,
                        "relationship": rel,
                    })
                    db.execute(
                        "UPDATE memories SET connections = ? WHERE id = ?",
                        (json.dumps(existing), mid),
                    )
    placeholders = ",".join("?" * len(source_ids))
    db.execute(
        f"UPDATE memories SET consolidated = 1 WHERE id IN ({placeholders})",
        source_ids,
    )
    db.commit()
    db.close()
    log.info(f"🔄 Consolidated {len(source_ids)} memories. Insight: {insight[:80]}...")
    return {
        "status": "consolidated",
        "memories_processed": len(source_ids),
        "insight": insight,
    }


def read_consolidation_history() -> dict:
    """Read past consolidation insights."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM consolidations ORDER BY created_at DESC LIMIT 10"
    ).fetchall()
    result = [
        {
            "summary": r["summary"],
            "insight": r["insight"],
            "source_ids": r["source_ids"],
        }
        for r in rows
    ]
    db.close()
    return {"consolidations": result, "count": len(result)}


def get_memory_stats() -> dict:
    """Get current memory statistics."""
    db = get_db()
    total = db.execute("SELECT COUNT(*) as c FROM memories").fetchone()["c"]
    unconsolidated = db.execute(
        "SELECT COUNT(*) as c FROM memories WHERE consolidated = 0"
    ).fetchone()["c"]
    consolidations = db.execute(
        "SELECT COUNT(*) as c FROM consolidations"
    ).fetchone()["c"]
    db.close()
    return {
        "total_memories": total,
        "unconsolidated": unconsolidated,
        "consolidations": consolidations,
    }


def delete_memory(memory_id: int) -> dict:
    """Delete a memory by ID."""
    db = get_db()
    row = db.execute("SELECT 1 FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        db.close()
        return {"status": "not_found", "memory_id": memory_id}
    db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    db.commit()
    db.close()
    log.info(f"🗑️  Deleted memory #{memory_id}")
    return {"status": "deleted", "memory_id": memory_id}


def clear_all_memories(inbox_path: str | None = None) -> dict:
    """Delete all memories, consolidations, and inbox files. Full reset."""
    db = get_db()
    mem_count = db.execute("SELECT COUNT(*) as c FROM memories").fetchone()["c"]
    db.execute("DELETE FROM memories")
    db.execute("DELETE FROM consolidations")
    db.execute("DELETE FROM processed_files")
    db.commit()
    db.close()

    files_deleted = 0
    if inbox_path:
        folder = Path(inbox_path)
        if folder.is_dir():
            for f in folder.iterdir():
                if f.name.startswith("."):
                    continue
                try:
                    if f.is_file():
                        f.unlink()
                        files_deleted += 1
                    elif f.is_dir():
                        shutil.rmtree(f)
                        files_deleted += 1
                except OSError as e:
                    log.error(f"Failed to delete {f.name}: {e}")

    log.info(f"🗑️  Cleared all {mem_count} memories, deleted {files_deleted} inbox files")
    return {
        "status": "cleared",
        "memories_deleted": mem_count,
        "files_deleted": files_deleted,
    }


# ─── OpenAI Multi-Agent Runtime ────────────────────────────────


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Any] | None = None


@dataclass
class AgentDefinition:
    name: str
    model: str
    description: str
    instruction: str
    tools: list[ToolSpec] = field(default_factory=list)
    sub_agents: list["AgentDefinition"] = field(default_factory=list)


NO_ARGS_SCHEMA = {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": False,
}

ROUTE_TOOL_NAME = "select_sub_agent"
ROUTE_TOOL_SCHEMA = {
    "type": "function",
    "name": ROUTE_TOOL_NAME,
    "description": "Select which sub-agent should handle the current request.",
    "parameters": {
        "type": "object",
        "properties": {
            "agent_name": {"type": "string"},
            "task": {"type": "string"},
        },
        "required": ["agent_name", "task"],
        "additionalProperties": False,
    },
}


def build_agents(model: str = DEFAULT_MODEL) -> tuple[AgentDefinition, dict[str, AgentDefinition]]:
    ingest_agent = AgentDefinition(
        name="ingest_agent",
        model=model,
        description="Processes raw text or media into structured memory. Call this when new information arrives.",
        instruction=(
            "You are a Memory Ingest Agent. You handle ALL types of input — text, images,\n"
            "audio, video, and PDFs. For any input you receive:\n"
            "1. Thoroughly describe what the content contains\n"
            "2. Create a concise 1-2 sentence summary\n"
            "3. Extract key entities (people, companies, products, concepts, objects, locations)\n"
            "4. Assign 2-4 topic tags\n"
            "5. Rate importance from 0.0 to 1.0\n"
            "6. Call store_memory with all extracted information\n\n"
            "For images: describe the scene, objects, text, people, and any visual details.\n"
            "For audio/video: describe the spoken content, sounds, scenes, and key moments.\n"
            "For PDFs: extract and summarize the document content.\n\n"
            "Use the full description as raw_text in store_memory so the context is preserved.\n"
            "Always call store_memory. Be concise and accurate.\n"
            "After storing, confirm what was stored in one sentence."
        ),
        tools=[
            ToolSpec(
                name="store_memory",
                description="Store a processed memory in the SQLite memory store.",
                parameters={
                    "type": "object",
                    "properties": {
                        "raw_text": {"type": "string"},
                        "summary": {"type": "string"},
                        "entities": {"type": "array", "items": {"type": "string"}},
                        "topics": {"type": "array", "items": {"type": "string"}},
                        "importance": {"type": "number"},
                        "source": {"type": "string"},
                    },
                    "required": ["raw_text", "summary", "entities", "topics", "importance"],
                    "additionalProperties": False,
                },
                handler=store_memory,
            ),
        ],
    )

    consolidate_agent = AgentDefinition(
        name="consolidate_agent",
        model=model,
        description="Merges related memories and finds patterns. Call this periodically.",
        instruction=(
            "You are a Memory Consolidation Agent. You:\n"
            "1. Call read_unconsolidated_memories to see what needs processing\n"
            "2. If fewer than 2 memories, say nothing to consolidate\n"
            "3. Find connections and patterns across the memories\n"
            "4. Create a synthesized summary and one key insight\n"
            "5. Call store_consolidation with source_ids, summary, insight, and connections\n\n"
            "Connections: list of dicts with 'from_id', 'to_id', 'relationship' keys.\n"
            "Think deeply about cross-cutting patterns."
        ),
        tools=[
            ToolSpec(
                name="read_unconsolidated_memories",
                description="Read unconsolidated memories from the SQLite memory store.",
                parameters=NO_ARGS_SCHEMA,
                handler=read_unconsolidated_memories,
            ),
            ToolSpec(
                name="store_consolidation",
                description="Store consolidation results and update source memories.",
                parameters={
                    "type": "object",
                    "properties": {
                        "source_ids": {"type": "array", "items": {"type": "integer"}},
                        "summary": {"type": "string"},
                        "insight": {"type": "string"},
                        "connections": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "from_id": {"type": "integer"},
                                    "to_id": {"type": "integer"},
                                    "relationship": {"type": "string"},
                                },
                                "required": ["from_id", "to_id", "relationship"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["source_ids", "summary", "insight", "connections"],
                    "additionalProperties": False,
                },
                handler=store_consolidation,
            ),
        ],
    )

    query_agent = AgentDefinition(
        name="query_agent",
        model=model,
        description="Answers questions using stored memories.",
        instruction=(
            "You are a Memory Query Agent. When asked a question:\n"
            "1. Call read_all_memories to access the memory store\n"
            "2. Call read_consolidation_history for higher-level insights\n"
            "3. Synthesize an answer based ONLY on stored memories\n"
            "4. Reference memory IDs: [Memory 1], [Memory 2], etc.\n"
            "5. If no relevant memories exist, say so honestly\n\n"
            "Be thorough but concise. Always cite sources."
        ),
        tools=[
            ToolSpec(
                name="read_all_memories",
                description="Read all stored memories from the SQLite memory store.",
                parameters=NO_ARGS_SCHEMA,
                handler=read_all_memories,
            ),
            ToolSpec(
                name="read_consolidation_history",
                description="Read past consolidation insights from the SQLite memory store.",
                parameters=NO_ARGS_SCHEMA,
                handler=read_consolidation_history,
            ),
        ],
    )

    orchestrator = AgentDefinition(
        name="memory_orchestrator",
        model=model,
        description="Routes memory operations to specialist agents.",
        instruction=(
            "You are the Memory Orchestrator for an always-on memory system.\n"
            "Route requests to the right sub-agent:\n"
            "- New information -> ingest_agent\n"
            "- Consolidation request -> consolidate_agent\n"
            "- Questions -> query_agent\n"
            "- Status check -> call get_memory_stats and report\n\n"
            "After the delegated agent finishes, give a brief summary."
        ),
        tools=[
            ToolSpec(
                name="get_memory_stats",
                description="Get current counts for memories and consolidations.",
                parameters=NO_ARGS_SCHEMA,
                handler=get_memory_stats,
            ),
        ],
        sub_agents=[ingest_agent, consolidate_agent, query_agent],
    )

    agents = {
        orchestrator.name: orchestrator,
        ingest_agent.name: ingest_agent,
        consolidate_agent.name: consolidate_agent,
        query_agent.name: query_agent,
    }
    return orchestrator, agents


class OpenAIADKCompatibleRunner:
    def __init__(
        self,
        agent: AgentDefinition,
        app_name: str,
        session_service: InMemorySessionService,
        config: AppConfig,
    ):
        self.agent = agent
        self.app_name = app_name
        self.session_service = session_service
        self.config = config
        self.client = create_openai_client(config.main)
        _, self.agents = build_agents(config.main.model)

    async def run_async(
        self,
        user_id: str,
        session_id: str,
        new_message: Content,
    ):
        session = await self.session_service.get_session(session_id)
        text = await self._run_agent(
            agent_name=self.agent.name,
            session=session,
            user_id=user_id,
            user_message=new_message,
        )
        yield Event(content=Content(role="assistant", parts=[Part.from_text(text)]))

    async def _run_agent(
        self,
        agent_name: str,
        session: Session,
        user_id: str,
        user_message: Content,
        delegation_task: str | None = None,
        delegated_from: str | None = None,
    ) -> str:
        agent = self.agents[agent_name]
        session.history.append({
            "agent": agent_name,
            "role": "user",
            "delegated_from": delegated_from,
            "delegation_task": delegation_task,
        })

        if agent.sub_agents:
            routed_agent, route_task = await self._select_sub_agent(
                agent=agent,
                user_message=user_message,
            )
            if routed_agent != "self":
                specialist_response = await self._run_agent(
                    agent_name=routed_agent,
                    session=session,
                    user_id=user_id,
                    user_message=user_message,
                    delegation_task=route_task,
                    delegated_from=agent.name,
                )
                return await self._summarize_delegation(
                    agent=agent,
                    user_message=user_message,
                    delegated_agent=routed_agent,
                    delegation_task=route_task,
                    specialist_response=specialist_response,
                )

        return await self._run_agent_with_tools(
            agent=agent,
            user_message=user_message,
            delegation_task=delegation_task,
            delegated_from=delegated_from,
        )

    async def _run_agent_with_tools(
        self,
        agent: AgentDefinition,
        user_message: Content,
        delegation_task: str | None = None,
        delegated_from: str | None = None,
    ) -> str:
        response = await self._create_initial_response(
            agent=agent,
            user_message=user_message,
            delegation_task=delegation_task,
            delegated_from=delegated_from,
        )

        text_fragments: list[str] = []
        for _ in range(12):
            response_text = self._extract_text(response)
            if response_text:
                text_fragments.append(response_text)

            function_calls = self._extract_function_calls(response)
            if not function_calls:
                final = "\n".join(
                    fragment.strip() for fragment in text_fragments if fragment.strip()
                ).strip()
                return final or "No response generated."

            tool_outputs = []
            for call in function_calls:
                tool_output = await self._execute_tool_call(agent=agent, call=call)
                tool_outputs.append({
                    "type": "function_call_output",
                    "call_id": call["call_id"],
                    "output": json.dumps(tool_output),
                })

            response = await asyncio.to_thread(
                self.client.responses.create,
                model=agent.model,
                instructions=agent.instruction,
                tools=self._tool_payload(agent),
                previous_response_id=response.id,
                input=tool_outputs,
            )

        raise RuntimeError(f"{agent.name} exceeded the maximum tool-calling steps")

    async def _select_sub_agent(
        self,
        agent: AgentDefinition,
        user_message: Content,
    ) -> tuple[str, str]:
        heuristic = self._heuristic_route(agent, user_message)
        if heuristic is not None:
            return heuristic

        route_response = await asyncio.to_thread(
            self.client.responses.create,
            model=agent.model,
            instructions=self._routing_instructions(agent),
            tools=[ROUTE_TOOL_SCHEMA],
            input=[await self._content_to_input_message(user_message)],
        )
        function_calls = self._extract_function_calls(route_response)
        if function_calls:
            try:
                arguments = json.loads(function_calls[0]["arguments"] or "{}")
            except json.JSONDecodeError:
                arguments = {}
            target = arguments.get("agent_name", "self")
            task = arguments.get("task", "")
            valid_targets = {sub_agent.name for sub_agent in agent.sub_agents}
            if target in valid_targets:
                return target, task or f"Handle this request as {target}."
            if target == "self":
                return "self", task

        return "self", ""

    def _heuristic_route(
        self,
        agent: AgentDefinition,
        user_message: Content,
    ) -> tuple[str, str] | None:
        valid_targets = {sub_agent.name for sub_agent in agent.sub_agents}
        if not valid_targets:
            return None

        if any(part.kind == "bytes" for part in user_message.parts):
            return "ingest_agent", "Process this new multimedia information into structured memory."

        text = self._render_content_text(user_message).strip()
        lower = text.lower()
        if lower.startswith("remember this information") or lower.startswith("remember this file"):
            return "ingest_agent", "Process this new information into structured memory."
        if lower.startswith("consolidate unconsolidated memories"):
            return "consolidate_agent", "Consolidate the unconsolidated memories and find patterns."
        if lower.startswith("based on my memories, answer:"):
            return "query_agent", "Answer the question using stored memories."
        if lower.startswith("give me a status report on my memory system."):
            return "self", "Report current memory status."

        return None

    def _routing_instructions(self, agent: AgentDefinition) -> str:
        available = "\n".join(
            f"- {sub_agent.name}: {sub_agent.description}"
            for sub_agent in agent.sub_agents
        )
        return (
            f"{agent.instruction}\n\n"
            "Choose which sub-agent should handle this request.\n"
            "Available sub-agents:\n"
            f"{available}\n\n"
            "If the current agent should handle the request itself, choose 'self'.\n"
            "Return exactly one function call to select_sub_agent."
        )

    async def _create_initial_response(
        self,
        agent: AgentDefinition,
        user_message: Content,
        delegation_task: str | None = None,
        delegated_from: str | None = None,
    ):
        input_items = []
        if delegated_from and delegation_task:
            input_items.append({
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": (
                        f"Delegation context from {delegated_from}: {delegation_task}\n"
                        "Use the same shared memory store and complete the task."
                    ),
                }],
            })
        input_items.append(await self._content_to_input_message(user_message))

        return await asyncio.to_thread(
            self.client.responses.create,
            model=agent.model,
            instructions=agent.instruction,
            tools=self._tool_payload(agent),
            input=input_items,
        )

    async def _summarize_delegation(
        self,
        agent: AgentDefinition,
        user_message: Content,
        delegated_agent: str,
        delegation_task: str,
        specialist_response: str,
    ) -> str:
        original_request = self._render_content_text(user_message)
        summary_input = [{
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": (
                    f"Original request:\n{original_request or '[multimodal request]'}\n\n"
                    f"Delegated agent: {delegated_agent}\n"
                    f"Delegation task: {delegation_task or '[none provided]'}\n\n"
                    f"Specialist response:\n{specialist_response}\n\n"
                    "Give the final user-facing reply. Keep it brief, preserve citations, "
                    "and do not invent new facts."
                ),
            }],
        }]
        response = await asyncio.to_thread(
            self.client.responses.create,
            model=agent.model,
            instructions=agent.instruction,
            input=summary_input,
        )
        return self._extract_text(response) or specialist_response

    def _tool_payload(self, agent: AgentDefinition) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
            for tool in agent.tools
        ]

    async def _content_to_input_message(self, content: Content) -> dict[str, Any]:
        response_parts = []
        for part in content.parts:
            if part.kind == "text":
                response_parts.append({"type": "input_text", "text": part.text or ""})
            elif part.kind == "bytes":
                response_parts.append(await self._binary_part_to_input(part))
            else:
                raise ValueError(f"Unsupported part kind: {part.kind}")
        return {"role": content.role, "content": response_parts}

    async def _binary_part_to_input(self, part: Part) -> dict[str, Any]:
        mime_type = part.mime_type or "application/octet-stream"
        filename = part.filename or "upload"
        data = part.data or b""

        if mime_type.startswith("image/"):
            return {
                "type": "input_image",
                "image_url": self._to_data_url(data, mime_type),
            }

        uploaded = await asyncio.to_thread(self._upload_file, data, filename, mime_type)
        return {
            "type": "input_file",
            "file_id": uploaded.id,
        }

    def _upload_file(self, data: bytes, filename: str, mime_type: str):
        buffer = io.BytesIO(data)
        buffer.name = filename
        return self.client.files.create(file=buffer, purpose="user_data")

    @staticmethod
    def _to_data_url(data: bytes, mime_type: str) -> str:
        encoded = base64.b64encode(data).decode("utf-8")
        return f"data:{mime_type};base64,{encoded}"

    @staticmethod
    def _extract_text(response: Any) -> str:
        output_text = getattr(response, "output_text", None)
        if output_text:
            return output_text

        fragments: list[str] = []
        for item in getattr(response, "output", []) or []:
            if getattr(item, "type", "") != "message":
                continue
            for block in getattr(item, "content", []) or []:
                if getattr(block, "type", "") == "output_text":
                    fragments.append(getattr(block, "text", ""))
        return "\n".join(fragment for fragment in fragments if fragment)

    @staticmethod
    def _extract_function_calls(response: Any) -> list[dict[str, Any]]:
        function_calls: list[dict[str, Any]] = []
        for item in getattr(response, "output", []) or []:
            if getattr(item, "type", "") == "function_call":
                function_calls.append({
                    "name": getattr(item, "name", ""),
                    "arguments": getattr(item, "arguments", "{}"),
                    "call_id": getattr(item, "call_id", ""),
                })
        return function_calls

    @staticmethod
    def _render_content_text(content: Content) -> str:
        fragments = []
        for part in content.parts:
            if part.kind == "text" and part.text:
                fragments.append(part.text)
        return "\n\n".join(fragments)

    async def _execute_tool_call(self, agent: AgentDefinition, call: dict[str, Any]) -> dict[str, Any]:
        tool_map = {tool.name: tool for tool in agent.tools}
        tool = tool_map.get(call["name"])
        if tool is None:
            raise RuntimeError(f"{agent.name} tried to call unknown tool {call['name']}")

        try:
            arguments = json.loads(call["arguments"] or "{}")
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid JSON arguments for {call['name']}: {exc}") from exc

        if tool.handler is None:
            raise RuntimeError(f"Tool {tool.name} has no handler")

        if arguments:
            result = await asyncio.to_thread(tool.handler, **arguments)
        else:
            result = await asyncio.to_thread(tool.handler)
        return result


# ─── Agent Wrapper ─────────────────────────────────────────────


class MemoryAgent:
    def __init__(self, config: AppConfig | None = None):
        self.config = config or AppConfig.from_env()
        self.agent, _ = build_agents(self.config.main.model)
        self.session_service = InMemorySessionService()
        self.runner = OpenAIADKCompatibleRunner(
            agent=self.agent,
            app_name="memory_layer",
            session_service=self.session_service,
            config=self.config,
        )
        self.transcription_client = create_openai_client(self.config.transcription)

    async def run(self, message: str) -> str:
        session = await self.session_service.create_session(
            app_name="memory_layer",
            user_id="agent",
        )
        content = Content(role="user", parts=[Part.from_text(text=message)])
        return await self._execute(session, content)

    async def run_multimodal(
        self,
        text: str,
        file_bytes: bytes,
        mime_type: str,
        filename: str = "upload",
    ) -> str:
        session = await self.session_service.create_session(
            app_name="memory_layer",
            user_id="agent",
        )
        parts = [
            Part.from_text(text=text),
            Part.from_bytes(data=file_bytes, mime_type=mime_type, filename=filename),
        ]
        content = Content(role="user", parts=parts)
        return await self._execute(session, content)

    async def run_parts(self, parts: list[Part]) -> str:
        session = await self.session_service.create_session(
            app_name="memory_layer",
            user_id="agent",
        )
        return await self._execute(session, Content(role="user", parts=parts))

    async def _execute(self, session: Session, content: Content) -> str:
        response = ""
        async for event in self.runner.run_async(
            user_id="agent",
            session_id=session.id,
            new_message=content,
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text:
                        response += part.text
        return response

    async def ingest(self, text: str, source: str = "") -> str:
        msg = (
            f"Remember this information (source: {source}):\n\n{text}"
            if source
            else f"Remember this information:\n\n{text}"
        )
        return await self.run(msg)

    async def ingest_file(self, file_path: Path) -> str:
        """Ingest a media file (image, audio, video, PDF) via multimodal."""
        suffix = file_path.suffix.lower()
        mime_type = MEDIA_EXTENSIONS.get(suffix)
        if not mime_type:
            # Fallback to mimetypes module
            mime_type, _ = mimetypes.guess_type(str(file_path))
            mime_type = mime_type or "application/octet-stream"

        file_bytes = file_path.read_bytes()
        size_mb = len(file_bytes) / (1024 * 1024)

        # Match the original ADK app's guard for inline media size.
        if size_mb > 20:
            log.warning(f"⚠️  Skipping {file_path.name} ({size_mb:.1f}MB) — exceeds 20MB limit")
            return f"Skipped: file too large ({size_mb:.1f}MB)"

        if suffix in IMAGE_EXTENSIONS or suffix == ".pdf":
            prompt = (
                f"Remember this file (source: {file_path.name}, type: {mime_type}).\n\n"
                f"Thoroughly analyze the content of this {mime_type.split('/')[0]} file and "
                "extract all meaningful information for memory storage."
            )
            log.info(f"🔮 Ingesting {mime_type.split('/')[0]}: {file_path.name} ({size_mb:.1f}MB)")
            return await self.run_multimodal(
                text=prompt,
                file_bytes=file_bytes,
                mime_type=mime_type,
                filename=file_path.name,
            )

        if suffix in AUDIO_EXTENSIONS:
            log.info(f"🔮 Ingesting {mime_type.split('/')[0]}: {file_path.name} ({size_mb:.1f}MB)")
            transcript = await self._transcribe_file(file_path, mime_type, allow_fallback=True)
            return await self.run(
                f"Remember this file (source: {file_path.name}, type: {mime_type}).\n\n"
                f"Thoroughly analyze the content of this audio file and extract all meaningful "
                f"information for memory storage.\n\nAudio transcript:\n{transcript}"
            )

        if suffix in VIDEO_EXTENSIONS:
            log.info(f"🔮 Ingesting {mime_type.split('/')[0]}: {file_path.name} ({size_mb:.1f}MB)")
            transcript, frames = await self._preprocess_video(file_path)
            try:
                parts = [
                    Part.from_text(
                        f"Remember this file (source: {file_path.name}, type: {mime_type}).\n\n"
                        "Thoroughly analyze the content of this video file using the sampled "
                        "frames and audio transcript, and extract all meaningful information "
                        "for memory storage.\n\n"
                        f"Audio transcript:\n{transcript or '[no transcript extracted]'}"
                    )
                ]
                for frame_path in frames:
                    parts.append(Part.from_bytes(
                        data=frame_path.read_bytes(),
                        mime_type="image/jpeg",
                        filename=frame_path.name,
                    ))
                if len(parts) == 1 and not transcript:
                    raise RuntimeError(f"Failed to extract usable content from {file_path.name}")
                if len(parts) == 1:
                    return await self.run(parts[0].text or "")
                return await self.run_parts(parts)
            finally:
                for frame_path in frames:
                    try:
                        frame_path.unlink(missing_ok=True)
                    except OSError:
                        pass
                if frames:
                    try:
                        frames[0].parent.rmdir()
                    except OSError:
                        pass

        return await self.run_multimodal(
            text=(
                f"Remember this file (source: {file_path.name}, type: {mime_type}).\n\n"
                f"Thoroughly analyze the content of this {mime_type.split('/')[0]} file and "
                "extract all meaningful information for memory storage."
            ),
            file_bytes=file_bytes,
            mime_type=mime_type,
            filename=file_path.name,
        )

    async def _transcribe_file(
        self,
        file_path: Path,
        mime_type: str,
        allow_fallback: bool = False,
    ) -> str:
        return await asyncio.to_thread(
            self._transcribe_bytes,
            file_path.read_bytes(),
            file_path.name,
            mime_type,
            allow_fallback,
        )

    def _transcribe_bytes(
        self,
        data: bytes,
        filename: str,
        mime_type: str,
        allow_fallback: bool = False,
    ) -> str:
        buffer = io.BytesIO(data)
        buffer.name = filename
        try:
            transcript = self.transcription_client.audio.transcriptions.create(
                model=self.config.transcription.model,
                file=buffer,
            )
            return getattr(transcript, "text", "") or ""
        except Exception as exc:
            if allow_fallback:
                log.warning(f"Transcription failed for {filename}: {exc}")
                return ""
            raise

    async def _preprocess_video(self, file_path: Path) -> tuple[str, list[Path]]:
        return await asyncio.to_thread(self._preprocess_video_sync, file_path)

    def _preprocess_video_sync(self, file_path: Path) -> tuple[str, list[Path]]:
        with tempfile.TemporaryDirectory(prefix="memory-agent-video-") as tmpdir:
            temp_dir = Path(tmpdir)
            audio_path = temp_dir / "audio.wav"
            frames_dir = temp_dir / "frames"
            frames_dir.mkdir(parents=True, exist_ok=True)

            audio_cmd = [
                FFMPEG_BIN,
                "-y",
                "-i",
                str(file_path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                str(audio_path),
            ]
            frame_cmd = [
                FFMPEG_BIN,
                "-y",
                "-i",
                str(file_path),
                "-vf",
                f"fps=1/{VIDEO_FRAME_INTERVAL_SECONDS},scale=1280:-1:force_original_aspect_ratio=decrease",
                str(frames_dir / "frame_%03d.jpg"),
            ]

            transcript = ""
            try:
                subprocess.run(audio_cmd, check=True, capture_output=True)
                if audio_path.exists() and audio_path.stat().st_size > 0:
                    transcript = self._transcribe_bytes(
                        audio_path.read_bytes(),
                        audio_path.name,
                        "audio/wav",
                        True,
                    )
            except Exception as exc:
                log.warning(
                    f"Audio extraction failed for {file_path.name}: "
                    f"{self._format_exception_output(exc)}"
                )

            try:
                subprocess.run(frame_cmd, check=True, capture_output=True)
                frame_candidates = sorted(frames_dir.glob("frame_*.jpg"))[:MAX_VIDEO_FRAMES]
                retained_paths = []
                for index, frame in enumerate(frame_candidates):
                    retained = temp_dir / f"retained_{index:03d}.jpg"
                    retained.write_bytes(frame.read_bytes())
                    retained_paths.append(retained)
            except subprocess.CalledProcessError as exc:
                log.warning(f"Frame extraction failed for {file_path.name}: {exc.stderr.decode(errors='ignore')}")
                retained_paths = []

            if not retained_paths:
                thumbnail_cmd = [
                    FFMPEG_BIN,
                    "-y",
                    "-i",
                    str(file_path),
                    "-frames:v",
                    "1",
                    str(temp_dir / "retained_000.jpg"),
                ]
                try:
                    subprocess.run(thumbnail_cmd, check=True, capture_output=True)
                    fallback_frame = temp_dir / "retained_000.jpg"
                    if fallback_frame.exists():
                        retained_paths = [fallback_frame]
                except subprocess.CalledProcessError as exc:
                    log.warning(
                        f"Thumbnail extraction failed for {file_path.name}: "
                        f"{self._format_exception_output(exc)}"
                    )

            persisted_dir = Path(tempfile.mkdtemp(prefix="memory-agent-video-parts-"))
            persisted_frames = []
            for frame in retained_paths:
                dest = persisted_dir / frame.name
                dest.write_bytes(frame.read_bytes())
                persisted_frames.append(dest)
            return transcript, persisted_frames

    @staticmethod
    def _format_exception_output(exc: Exception) -> str:
        stderr = getattr(exc, "stderr", b"")
        if isinstance(stderr, bytes) and stderr:
            return stderr.decode(errors="ignore")
        return str(exc)

    async def consolidate(self) -> str:
        return await self.run(
            "Consolidate unconsolidated memories. Find connections and patterns."
        )

    async def query(self, question: str) -> str:
        return await self.run(f"Based on my memories, answer: {question}")

    async def status(self) -> str:
        return await self.run("Give me a status report on my memory system.")


# ─── File Watcher ──────────────────────────────────────────────


async def watch_folder(agent: MemoryAgent, folder: Path, poll_interval: int = 5):
    """Watch a folder for new files and ingest them (text, images, audio, video, PDFs)."""
    folder.mkdir(parents=True, exist_ok=True)
    db = get_db()
    log.info(f"👁️  Watching: {folder}/  (supports: text, images, audio, video, PDFs)")

    while True:
        try:
            for f in sorted(folder.iterdir()):
                if f.name.startswith("."):
                    continue
                suffix = f.suffix.lower()
                if suffix not in ALL_SUPPORTED:
                    continue
                row = db.execute(
                    "SELECT 1 FROM processed_files WHERE path = ?",
                    (str(f),),
                ).fetchone()
                if row:
                    continue

                try:
                    if suffix in TEXT_EXTENSIONS:
                        # Text-based files — read as string
                        log.info(f"📄 New text file: {f.name}")
                        text = f.read_text(encoding="utf-8", errors="replace")[:10000]
                        if text.strip():
                            await agent.ingest(text, source=f.name)
                    else:
                        # Media files — send as multimodal bytes
                        log.info(f"🖼️  New media file: {f.name}")
                        await agent.ingest_file(f)
                except Exception as file_err:
                    log.error(f"Error ingesting {f.name}: {file_err}")

                db.execute(
                    "INSERT INTO processed_files (path, processed_at) VALUES (?, ?)",
                    (str(f), datetime.now(timezone.utc).isoformat()),
                )
                db.commit()
        except Exception as e:
            log.error(f"Watch error: {e}")

        await asyncio.sleep(poll_interval)


# ─── Consolidation Timer ──────────────────────────────────────


async def consolidation_loop(agent: MemoryAgent, interval_minutes: int = 30):
    """Run consolidation periodically, like sleep cycles."""
    log.info(f"🔄 Consolidation: every {interval_minutes} minutes")
    while True:
        await asyncio.sleep(interval_minutes * 60)
        try:
            db = get_db()
            count = db.execute(
                "SELECT COUNT(*) as c FROM memories WHERE consolidated = 0"
            ).fetchone()["c"]
            db.close()
            if count >= 2:
                log.info(f"🔄 Running consolidation ({count} unconsolidated memories)...")
                result = await agent.consolidate()
                log.info(f"🔄 {result[:100]}")
            else:
                log.info(f"🔄 Skipping consolidation ({count} unconsolidated memories)")
        except Exception as e:
            log.error(f"Consolidation error: {e}")


# ─── HTTP API ──────────────────────────────────────────────────


def build_http(agent: MemoryAgent, watch_path: str = "./inbox"):
    app = web.Application()

    async def handle_query(request: web.Request):
        q = request.query.get("q", "").strip()
        if not q:
            return web.json_response({"error": "missing ?q= parameter"}, status=400)
        answer = await agent.query(q)
        return web.json_response({"question": q, "answer": answer})

    async def handle_ingest(request: web.Request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        text = data.get("text", "").strip()
        if not text:
            return web.json_response({"error": "missing 'text' field"}, status=400)
        source = data.get("source", "api")
        result = await agent.ingest(text, source=source)
        return web.json_response({"status": "ingested", "response": result})

    async def handle_consolidate(request: web.Request):
        result = await agent.consolidate()
        return web.json_response({"status": "done", "response": result})

    async def handle_status(request: web.Request):
        stats = get_memory_stats()
        return web.json_response(stats)

    async def handle_memories(request: web.Request):
        data = read_all_memories()
        return web.json_response(data)

    async def handle_delete(request: web.Request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        memory_id = data.get("memory_id")
        if not memory_id:
            return web.json_response({"error": "missing 'memory_id' field"}, status=400)
        result = delete_memory(int(memory_id))
        return web.json_response(result)

    async def handle_clear(request: web.Request):
        result = clear_all_memories(inbox_path=watch_path)
        return web.json_response(result)

    app.router.add_get("/query", handle_query)
    app.router.add_post("/ingest", handle_ingest)
    app.router.add_post("/consolidate", handle_consolidate)
    app.router.add_get("/status", handle_status)
    app.router.add_get("/memories", handle_memories)
    app.router.add_post("/delete", handle_delete)
    app.router.add_post("/clear", handle_clear)

    return app


# ─── Main ──────────────────────────────────────────────────────


async def main_async(args):
    agent = MemoryAgent()

    log.info("🧠 Agent Memory Layer starting")
    log.info(f"   Model: {agent.config.main.model}")
    log.info(f"   OpenAI Base URL: {agent.config.main.base_url}")
    log.info(f"   Transcription Model: {agent.config.transcription.model}")
    log.info(f"   Transcription Base URL: {agent.config.transcription.base_url}")
    log.info(f"   Database: {DB_PATH}")
    log.info(f"   Watch: {args.watch}")
    log.info(f"   Consolidate: every {args.consolidate_every}m")
    log.info(f"   API: http://localhost:{args.port}")
    log.info("")

    tasks = [
        asyncio.create_task(watch_folder(agent, Path(args.watch))),
        asyncio.create_task(consolidation_loop(agent, args.consolidate_every)),
    ]

    app = build_http(agent, watch_path=args.watch)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", args.port)
    await site.start()

    log.info(f"✅ Agent running. Drop files in {args.watch}/ or POST to http://localhost:{args.port}/ingest")
    log.info("   Supported: text, images, audio, video, PDFs")
    log.info("")

    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        pass
    finally:
        await runner.cleanup()


def main():
    parser = argparse.ArgumentParser(description="Agent Memory Layer - Always-On OpenAI Agent")
    parser.add_argument("--watch", default="./inbox", help="Folder to watch for new files (default: ./inbox)")
    parser.add_argument("--port", type=int, default=8888, help="HTTP API port (default: 8888)")
    parser.add_argument("--consolidate-every", type=int, default=30, help="Consolidation interval in minutes (default: 30)")
    args = parser.parse_args()

    loop = asyncio.new_event_loop()

    def shutdown(sig):
        log.info(f"\n👋 Shutting down (signal {sig})...")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown, sig)

    try:
        loop.run_until_complete(main_async(args))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        loop.close()
        log.info("🧠 Agent stopped.")


if __name__ == "__main__":
    main()
