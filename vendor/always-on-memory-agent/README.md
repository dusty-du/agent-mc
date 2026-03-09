# Always On Memory Agent

**An always-on AI memory agent built with the OpenAI SDK and a root-orchestrated multi-agent runtime**

Most AI agents have amnesia. They process information when asked, then forget everything. This project gives agents a persistent, evolving memory that runs 24/7 as a lightweight background process, continuously processing, consolidating, and connecting information.

No vector database. No embeddings. Just an LLM that reads, thinks, and writes structured memory.

## The Problem

Current approaches to LLM memory fall short:

| Approach | Limitation |
|---|---|
| **Vector DB + RAG** | Passive. Embed once, retrieve later. No active processing. |
| **Conversation summary** | Loses detail over time. No cross-reference. |
| **Knowledge graphs** | Expensive to build and maintain. |

The gap: most systems store information, but they do not actively consolidate it. Humans do. During sleep, the brain replays, connects, and compresses information. This agent does the same thing.

## Architecture

![Architecture Diagram](docs/architecture.png)

The OpenAI port preserves the original architecture exactly:

- The **Memory Orchestrator** is the root agent for every request.
- The orchestrator routes work to one specialist agent at a time.
- Each specialist agent has its own scoped tools for reading from or writing to the SQLite memory store.
- All agents operate against the same `memory.db`.

## How It Works

### 1. Ingest

Feed the agent **any file**: text, images, audio, video, or PDFs. The **IngestAgent** uses OpenAI multimodal reasoning plus its own `store_memory` tool to extract structured information and write it to memory.

```text
Input: "Anthropic reports 62% of Claude usage is code-related.
        AI agents are the fastest growing category."
           |
           v
   +---------------------------------------------+
   | Summary:  Anthropic reports 62% of Claude   |
   |           usage is code-related...          |
   | Entities: [Anthropic, Claude, AI agents]    |
   | Topics:   [AI, code generation, agents]     |
   | Importance: 0.8                             |
   +---------------------------------------------+
```

**Supported file types (27 total):**

| Category | Extensions |
|---|---|
| Text | `.txt`, `.md`, `.json`, `.csv`, `.log`, `.xml`, `.yaml`, `.yml` |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg` |
| Audio | `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.aac` |
| Video | `.mp4`, `.webm`, `.mov`, `.avi`, `.mkv` |
| Documents | `.pdf` |

**Media handling in the OpenAI port:**

- **Images / PDFs** go directly to the main OpenAI Responses API client for multimodal analysis.
- **Audio** is transcribed first through a dedicated transcription OpenAI client, then passed to the IngestAgent.
- **Video** is preprocessed with `ffmpeg` to extract audio plus sampled frames, then passed to the IngestAgent.

**Three ways to ingest:**

- **File watcher**: Drop any supported file in the `./inbox` folder. The agent picks it up automatically.
- **Dashboard upload**: Use the upload control in the Streamlit dashboard.
- **HTTP API**: `POST /ingest` with text content.

### 2. Consolidate

The **ConsolidateAgent** runs on a timer (default: every 30 minutes). Like the human brain during sleep, it:

- Reviews unconsolidated memories
- Finds connections between them
- Generates cross-cutting insights
- Compresses related information

```text
Memory #1: "AI agents are growing fast but reliability is a challenge"
Memory #2: "Q1 priority: reduce inference costs by 40%"
Memory #3: "Current LLM memory approaches all have gaps"
Memory #4: "Smart inbox idea: persistent AI memory for email"
                   |
                   v  ConsolidateAgent
   +---------------------------------------------+
   | Connections:                                |
   |   #1 <-> #3: reliability needs better       |
   |            memory architectures             |
   |   #2 <-> #1: cost reduction enables         |
   |            agent deployment                 |
   |   #3 <-> #4: smart inbox is an application  |
   |            of reconstructive memory         |
   |                                             |
   | Insight: "The bottleneck for next-gen AI    |
   | tools is the transition from static RAG     |
   | to dynamic memory systems"                  |
   +---------------------------------------------+
```

### 3. Query

Ask any question. The **QueryAgent** reads stored memories and consolidation history through its own read tools, then synthesizes an answer with source citations:

```text
Q: "What should I focus on?"

A: "Based on your memories, prioritize:
   1. Ship the API by March 15 [Memory 2]
   2. The agent reliability gap [Memory 1] could be addressed
      by the reconstructive memory approach [Memory 3]
   3. The smart inbox concept [Memory 4] validates the
      market need for persistent AI memory"
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/Shubhamsaboo/always-on-memory-agent.git
cd always-on-memory-agent
pip install -r requirements.txt
```

### 2. Configure OpenAI clients

```bash
export MEMORY_OPENAI_BASE_URL="https://api.openai.com/v1"
export MEMORY_OPENAI_API_KEY="your-openai-api-key"
export TRANSCRIPTION_OPENAI_BASE_URL="https://api.openai.com/v1"
export TRANSCRIPTION_OPENAI_API_KEY="your-transcription-api-key"
```

Optional model overrides:

```bash
export MODEL="gpt-4.1-mini"
export TRANSCRIPTION_MODEL="gpt-4o-mini-transcribe"
```

The main runtime and transcription use separate OpenAI clients. There is no shared endpoint or API key fallback between them. If you want both clients to talk to the same provider, set both base URLs and both API keys explicitly.

### 3. Start the agent

```bash
python agent.py
```

That starts the full system:

- Watches `./inbox/` for new files
- Consolidates every 30 minutes
- Serves queries at `http://localhost:8888`

If you want video ingestion, make sure `ffmpeg` is installed and available on your `PATH`.

### 4. Feed it information

**Option A: Drop any file**

```bash
echo "Some important information" > inbox/notes.txt
cp photo.jpg inbox/
cp meeting.mp3 inbox/
cp report.pdf inbox/
# Agent auto-ingests within 5-10 seconds
```

**Option B: HTTP API**

```bash
curl -X POST http://localhost:8888/ingest \
  -H "Content-Type: application/json" \
  -d '{"text": "AI agents are the future", "source": "article"}'
```

### 5. Query

```bash
curl "http://localhost:8888/query?q=what+do+you+know"
```

### 6. Dashboard (optional)

```bash
streamlit run dashboard.py
```

The dashboard connects to the running agent and provides a visual interface for:

- Ingesting text and uploading files
- Querying memory with natural language
- Browsing and deleting stored memories
- Triggering manual consolidation

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/status` | GET | Memory statistics (counts) |
| `/memories` | GET | List all stored memories |
| `/ingest` | POST | Ingest new text (`{"text": "...", "source": "..."}`) |
| `/query?q=...` | GET | Query memory with a question |
| `/consolidate` | POST | Trigger manual consolidation |
| `/delete` | POST | Delete a memory (`{"memory_id": 1}`) |
| `/clear` | POST | Delete all memories (full reset) |

## CLI Options

```bash
python agent.py [options]

  --watch DIR              Folder to watch (default: ./inbox)
  --port PORT              HTTP API port (default: 8888)
  --consolidate-every MIN  Consolidation interval (default: 30)
```

## Project Structure

```text
always-on-memory-agent/
├── agent.py          # OpenAI-backed multi-agent runtime
├── dashboard.py      # Streamlit UI (connects to agent API)
├── requirements.txt  # Dependencies
├── inbox/            # Drop any file here for auto-ingestion
├── docs/             # Architecture + visual assets
└── memory.db         # SQLite database (created automatically)
```

## Why the OpenAI SDK?

This agent runs continuously. Cost and speed matter more than raw intelligence for background processing:

- **Tool calling fits the design**: the orchestrator and specialist agents keep their own responsibilities and tool boundaries.
- **Multimodal support**: images, PDFs, audio-assisted ingestion, and video preprocessing fit naturally into the same runtime.
- **One SDK for the whole loop**: routing, extraction, synthesis, and grounded answers all live in a single model interface.

## Built With

- OpenAI Python SDK
- OpenAI Responses API for orchestration, tool calling, and multimodal reasoning
- SQLite for persistent memory storage
- aiohttp for the HTTP API
- Streamlit for the dashboard

## License

MIT
