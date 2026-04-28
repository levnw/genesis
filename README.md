# Genesis

A personal AI backend that runs on a home server. It scrapes school tasks from ManageBac, syncs them to Notion, and answers questions using OpenAI GPT-4o with your real task data as context.

Built as four independent microservices so any one piece can be restarted or rebuilt without touching the others.

---

## Architecture

```
                         ┌─────────────────────────────────┐
                         │         gateway  :3000           │
                         │   auth + reverse proxy only      │
                         └────┬──────────┬──────────┬───────┘
                              │          │          │
                    ┌─────────▼──┐  ┌────▼─────┐  ┌▼────────┐
                    │  scraper   │  │  notion  │  │   ai    │
                    │   :3001    │  │  :3002   │  │  :3003  │
                    │ Playwright │  │ Notion   │  │  GPT-4o │
                    │ → local    │  │ API R/W  │  │  Ollama │
                    │   JSON     │  │          │  │         │
                    └────────────┘  └──────────┘  └─────────┘
                              │          ▲
                              └──────────┘
                           shared data/  dir
```

| Service | Port | Responsibility |
|---|---|---|
| `gateway` | 3000 | Auth (`x-api-key`), reverse proxy — only public-facing port |
| `scraper` | 3001 | Playwright → ManageBac → local JSON. No Notion, no AI |
| `notion`  | 3002 | All Notion reads and writes. Reads scraped JSON, writes to Notion |
| `ai`      | 3003 | All AI inference. GPT-4o for Q&A, Ollama (llama3.2) for emoji picking |
| `memory`  | 8765 | MemPalace vector memory bridge (Python/Flask sidecar) |

The scraper and notion services share a `data/` directory. The AI service never talks to Notion directly — it calls the notion service over HTTP. Nothing except the gateway should be exposed externally.

---

## Requirements

- **Node.js** 18+ (all four main services)
- **Python 3.11+** (MemPalace memory bridge)
- **Playwright** browsers: `npx playwright install chromium`
- **Ollama** running locally with `llama3.2` pulled: `ollama pull llama3.2`
- **OpenAI API key** (GPT-4o)
- **Notion API key** and a Notion Tasks database
- **ManageBac** student account

---

## Setup

### 1. Install dependencies

```bash
cd gateway  && npm install
cd ../scraper && npm install
cd ../notion  && npm install
cd ../ai      && npm install

# Memory bridge
pip3 install mempalace flask
```

### 2. Configure environment files

Copy the `.env.example` files (or create them from the templates below) and fill in your credentials.

**`gateway/.env`**
```
PORT=3000
API_KEY=                    # openssl rand -hex 20
SCRAPER_URL=http://localhost:3001
NOTION_URL=http://localhost:3002
AI_URL=http://localhost:3003
```

**`scraper/.env`**
```
PORT=3001
MB_EMAIL=                   # ManageBac login email
MB_PASSWORD=                # ManageBac password
DATA_DIR=../data
```

**`notion/.env`**
```
PORT=3002
NOTION_API_KEY=             # From notion.so/my-integrations
NOTION_TASKS_DB=            # Database ID from the Notion URL
DATA_DIR=../data
AI_SERVICE_URL=http://localhost:3003
```

**`ai/.env`**
```
PORT=3003
OPENAI_API_KEY=             # From platform.openai.com
OPENAI_MODEL=gpt-4o
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
NOTION_SERVICE_URL=http://localhost:3002
MEMPALACE_URL=http://localhost:8765
```

### 3. Start all services

```bash
# With pm2 (recommended)
pm2 start gateway/server.js  --name genesis-gateway
pm2 start scraper/server.js  --name genesis-scraper
pm2 start notion/server.js   --name genesis-notion
pm2 start ai/server.js       --name genesis-ai
pm2 start /opt/homebrew/bin/python3.11 --name genesis-memory \
  -- /path/to/genesis/ai/mempalace_bridge.py
pm2 save

# Or manually
node gateway/server.js &
node scraper/server.js &
node notion/server.js  &
node ai/server.js      &
python3 ai/mempalace_bridge.py &
```

### 4. First-time ManageBac setup

```bash
# Log in and discover your classes
curl -X POST -H "x-api-key: YOUR_KEY" http://localhost:3000/scrape/login

# If class conflicts are returned (two "Spanish" etc), choose which to keep
curl -X POST -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabledClassIds":["12345","67890"]}' \
  http://localhost:3000/scrape/setup

# Run first scrape
curl -X POST -H "x-api-key: YOUR_KEY" http://localhost:3000/scrape/scrape

# Sync to Notion
curl -X POST -H "x-api-key: YOUR_KEY" http://localhost:3000/notion/sync
```

---

## Authentication

Every request (except `GET /health`) requires:

```
x-api-key: YOUR_API_KEY
```

Missing or wrong key returns:
```json
{ "error": "UNAUTHORIZED", "message": "Missing or invalid x-api-key header" }
```

---

## API Reference

All responses are JSON. Errors always follow this shape:
```json
{ "error": "ERROR_CODE", "message": "Human-readable description", "details": "Optional" }
```

---

### Health

#### `GET /health`
No auth required. Pings all three services.

```json
{
  "ok": true,
  "services": [
    { "name": "scraper", "ok": true },
    { "name": "notion",  "ok": true },
    { "name": "ai",      "ok": true }
  ]
}
```

---

### AI

#### `POST /ai/ask`
Ask a question in plain English. Automatically fetches relevant Notion task context and answers using GPT-4o.

```json
// Request
{ "question": "What homework do I have due this week?" }

// Response
{
  "answer": "You have 3 tasks due this week: ...",
  "context_truncated": false
}
```

- For simple queries ("what's due today"), fetches task summaries.
- For deep queries ("build me a study plan for Biology"), fetches full task details including descriptions and attachment text.
- `context_truncated: true` means the context exceeded the ~8,000-token budget and was trimmed. Answer is still valid.
- Q&A pairs are stored in MemPalace for future context.

---

#### `POST /ai/note`
Add a note to a task in plain language. The AI identifies which Notion page you mean and appends the note as a callout block — never overwrites existing content.

```json
// Request
{ "text": "For the history essay I want to focus on economic causes of WW1" }

// Response
{ "ok": true, "page": "History Essay — Causes of WW1" }
```

---

### Notion

#### `GET /notion/tasks`
Query the Notion tasks database.

| Param | Description |
|---|---|
| `date=today` | Only tasks due today |
| `class=Biology` | Filter by class name |
| `all=true` | All tasks, no filter |
| `detail=true` | Include full description + attachment list |

**Summary response (default):**
```json
[
  {
    "id": "notion-page-id",
    "title": "Lab Report — Enzyme Activity",
    "due": "2026-04-30",
    "status": "Complete",
    "submissionStatus": "Submitted",
    "class": "Biology",
    "tags": ["Summative"],
    "grades": "A: 7/8 · B: 6/8",
    "teacherComment": "Good analysis, improve conclusion.",
    "url": "https://app.managebac.com/student/core_tasks/12345",
    "lastEdited": "2026-04-28T10:00:00.000Z"
  }
]
```

**With `detail=true`, adds:**
```json
{
  "description": "Full body text of the task page...",
  "attachments": [
    { "pageId": "sub-page-id", "title": "📎 Lab Instructions.pdf" }
  ]
}
```

---

#### `GET /notion/tasks/:pageId/attachments`
Get extracted text content of attachments for a task. PDFs are converted to plain text during sync and stored as Notion sub-pages.

```json
[{ "title": "📎 Lab Instructions.pdf", "text": "Extracted plain text..." }]
```

---

#### `GET /notion/search?q=keyword`
Search tasks by title.

```json
[{ "id": "...", "title": "History Essay", "due": "2026-05-10", "class": "History", "url": "..." }]
```

---

#### `POST /notion/sync`
Read all scraped JSON files and push to Notion. Runs emoji assignment in the background after sync.

```json
// Request (optional)
{ "force": false }
```

- `force: false` (default) — protects user edits. If a Notion page was manually edited, only updates factual fields (grades, submission status).
- `force: true` — overwrites all fields regardless.

```json
// Response
{ "ok": true, "created": 5, "updated": 12, "partial": 2, "failed": 0, "total": 19 }
```

- `partial` — pages where user edits were detected; only safe fields were updated.

---

#### `POST /notion/sync/task`
Sync a single task by local task ID.

```json
{ "taskId": "task_00001" }
→ { "ok": true, "action": "updated", "pageId": "notion-page-id" }
```

---

#### `POST /notion/note`
Append a note block directly to a Notion page (lower-level — requires page ID).

```json
{ "pageId": "notion-page-id", "text": "Note text here" }
→ { "ok": true }
```

---

### Scraper

#### `POST /scrape/login`
First-time setup. Logs in to ManageBac with Playwright, discovers all enrolled classes.

```json
// Response (no conflicts)
{ "ok": true, "classes": 8, "message": "All classes enabled. Run POST /scrape/scrape to start." }

// Response (with conflicts — two classes share the same subject)
{
  "ok": true,
  "classes": 8,
  "conflicts": [
    [
      { "classId": "99999", "name": "Spanish Phase 1 (Grade 10)", "suggested": "keep" },
      { "classId": "88888", "name": "Spanish Phase 1 (Grade 9)",  "suggested": "skip" }
    ]
  ]
}
```

If conflicts exist, call `POST /scrape/setup` to resolve them before scraping.

---

#### `POST /scrape/setup`
Resolve class conflicts. Saves config permanently — won't be asked again unless you re-login.

```json
{ "enabledClassIds": ["99999", "12345", "67890"] }
→ { "ok": true, "enabled": ["Biology", "Spanish Phase 1 (Grade 10)"], "disabled": ["Spanish Phase 1 (Grade 9)"] }
```

---

#### `GET /scrape/classes`
List all discovered classes and their enabled status.

```json
[
  { "class_id": "biology", "managebac_class_id": "12345", "name": "Biology", "enabled": true },
  { "class_id": "spanish-old", "managebac_class_id": "88888", "name": "Spanish (Grade 9)", "enabled": false }
]
```

---

#### `POST /scrape/scrape`
Scrape all enabled classes. Saves to `data/` as JSON — does not write to Notion. Call `/notion/sync` after.

```json
// Request (optional)
{ "speed": "medium" }
```

Speed options: `slow` (1 tab, 2s delay) · `medium` (2 tabs, 0.7s delay) · `fast` (3 tabs, no delay)

```json
{ "ok": true, "totalTasks": 47, "classes": 8, "scraped_at": "2026-04-28T14:00:00.000Z" }
```

---

#### `POST /scrape/scrape/task`
Scrape a single task without running a full scrape.

```json
// By URL
{ "url": "https://app.managebac.com/student/core_tasks/12345" }

// By class + task name
{ "class": "Biology", "task": "Lab Report" }
```

---

#### `GET /scrape/status`
Last scrape result.

```json
{ "ok": true, "totalTasks": 47, "classes": 8, "scraped_at": "2026-04-28T14:00:00.000Z" }
```

---

## Typical Workflows

### First-time setup
```
POST /scrape/login
POST /scrape/setup          (only if class conflicts returned)
POST /scrape/scrape
POST /notion/sync
```

### Daily refresh
```
POST /scrape/scrape
POST /notion/sync
GET  /notion/tasks?date=today
POST /ai/ask  { "question": "anything" }
```

### Quick task lookup mid-class
```
POST /scrape/scrape/task  { "url": "..." }
POST /notion/sync/task    { "taskId": "..." }
POST /ai/ask              { "question": "summarise the task" }
```

### Add a note
```
POST /ai/note  { "text": "remember to include sources for the essay" }
```

---

## Data Flow

```
ManageBac
    ↓  Playwright browser automation
scraper  →  data/{classId}/tasks/{taskId}.json
    ↓
notion service  →  reads JSON, writes to Notion API
    ↓
Notion database
    ↓  queried by
ai service  →  context + GPT-4o  →  answer
```

Attachment flow during sync:
```
Task has PDF attachment
    ↓  pdf-parse
Plain text (if < 50KB)  →  Notion sub-page  "📎 filename"
Too large / failed      →  Notion sub-page  "📎 filename — [link]"
```

---

## Notes

- All timestamps are ISO 8601
- Task `id` is the local JSON ID (e.g. `task_00001`); Notion page `id` is a UUID
- Full scrape takes 2–10 min depending on speed setting — fire and forget, poll `/scrape/status`
- `/ai/ask` latency is ~2–4s (OpenAI API + Notion query)
- The `data/` directory and all `.env` files are gitignored — never committed
- Only the gateway port (3000) should be exposed; 3001–3003 and 8765 are internal only
