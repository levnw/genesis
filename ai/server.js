require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express       = require('express');
const fetch         = require('node-fetch');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);
const app  = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';

const NOTION_URL    = process.env.NOTION_SERVICE_URL || 'http://localhost:3002';
const MEMPALACE_URL = process.env.MEMPALACE_URL      || 'http://localhost:8765';

const CONTEXT_CHAR_LIMIT = 16000;
const TASK_DESC_LIMIT    = 1200;
const MAX_CONTEXT_TASKS  = 18;

// ── OpenClaw (primary) ────────────────────────────────────────────────────
const OPENCLAW_SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
const SESSIONS_PATH = path.join(OPENCLAW_SESSIONS_DIR, 'sessions.json');

function extractOpenClawJson(output) {
  for (const line of (output || '').split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) continue;
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p.payloads)) return p;
    } catch {}
  }
  const m = (output || '').match(/(\{[\s\S]*?"payloads"[\s\S]*?\})/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  return null;
}

function cleanupSession(sessionId) {
  try {
    for (const ext of ['.jsonl', '.jsonl.lock']) {
      const f = path.join(OPENCLAW_SESSIONS_DIR, `${sessionId}${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(SESSIONS_PATH)) {
      const s = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
      for (const k of Object.keys(s)) {
        if (s[k]?.sessionId === sessionId || k === 'agent:main:main') delete s[k];
      }
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2));
    }
  } catch {}
}

async function askOpenClaw(message) {
  const sessionId = randomUUID();
  try {
    // No hard timeout — let OpenClaw run as long as it needs
    const { stdout, stderr } = await execFileAsync(OPENCLAW_BIN, [
      'agent', '--agent', 'main', '--session-id', sessionId, '--json', '-m', message,
    ]);
    const data = extractOpenClawJson(`${stdout}\n${stderr}`);
    if (!data) throw new Error('No JSON from OpenClaw');
    return data.payloads?.map(p => p?.text || '').filter(Boolean).join('\n').trim();
  } catch (err) {
    const output = `${err.stdout || ''}\n${err.stderr || ''}`;
    const data = extractOpenClawJson(output);
    if (data) return data.payloads?.map(p => p?.text || '').filter(Boolean).join('\n').trim();
    throw err;
  } finally {
    cleanupSession(sessionId);
  }
}

async function askOllama(prompt, opts = {}) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.3,
        num_predict: opts.num_predict ?? 512,
      },
    }),
    timeout: 45000,
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return ((await r.json()).response || '').trim();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/ask', async (req, res) => {
  try {
    const { question, model = 'openclaw' } = req.body || {};
    if (!question) return res.status(400).json({ error: 'MISSING_QUESTION', message: 'question is required' });

    const useModel = model.toLowerCase();
    let answer;

    if (useModel === 'ollama') {
      answer = await ollamaFallback(question);
    } else {
      // openclaw (default) — agent handles everything itself; fall back to Ollama on error
      try {
        answer = await askOpenClaw(question);
      } catch (err) {
        console.warn('[ai] OpenClaw failed, falling back to Ollama:', err.message);
        answer = await ollamaFallback(question);
      }
    }

    res.json({ answer, model: useModel });
  } catch (err) {
    console.error('[ai] ask error:', err.message);
    res.status(500).json({ error: 'ASK_FAILED', message: err.message });
  }
});

app.post('/note', async (req, res) => {
  try {
    const { text, model = 'openclaw' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'MISSING_TEXT', message: 'text is required' });

    const useModel = model.toLowerCase();
    const extractPrompt = `Extract the task name and class name from this note. Reply with ONLY a JSON object: {"taskName": "...", "className": "..."}. If you cannot identify one, set it to null.\n\nNote: ${text}`;

    let extraction;
    if (useModel === 'ollama') {
      extraction = await askOllama(`${extractPrompt}\n\nJSON:`, { temperature: 0.1, num_predict: 100 });
    } else {
      try {
        extraction = await askOpenClaw(extractPrompt);
      } catch {
        extraction = await askOllama(`${extractPrompt}\n\nJSON:`, { temperature: 0.1, num_predict: 100 });
      }
    }

    let taskName = null, className = null;
    try {
      const m = extraction.match(/\{[\s\S]*\}/);
      const p = JSON.parse(m?.[0] || '{}');
      taskName  = p.taskName || null;
      className = p.className || null;
    } catch {}

    const searchQ = taskName || className || text.slice(0, 50);
    const r = await fetch(`${NOTION_URL}/search?q=${encodeURIComponent(searchQ)}`, { timeout: 8000 });
    if (!r.ok) return res.status(502).json({ error: 'NOTION_SEARCH_FAILED' });

    const results = await r.json();
    if (!results.length) return res.status(404).json({ error: 'TASK_NOT_FOUND', message: `No task found matching "${searchQ}"` });

    const page = results[0];
    const noteR = await fetch(`${NOTION_URL}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: page.id, text }),
      timeout: 8000,
    });
    if (!noteR.ok) return res.status(502).json({ error: 'NOTE_APPEND_FAILED' });

    res.json({ ok: true, page: page.title });
  } catch (err) {
    console.error('[ai] note error:', err.message);
    res.status(500).json({ error: 'NOTE_FAILED', message: err.message });
  }
});

app.post('/emoji', async (req, res) => {
  try {
    const { title, class: className, tags, description, usedEmojis = [] } = req.body || {};

    const avoidList = usedEmojis.reduce((acc, e) => { acc[e] = (acc[e] || 0) + 1; return acc; }, {});
    const avoid = Object.entries(avoidList).filter(([, c]) => c >= 3).map(([e]) => e).join(' ');

    const prompt =
`You are an emoji picker for a student's school task tracker.
Pick exactly ONE emoji that best represents this task.

Task name: "${title || ''}"
Subject: "${className || ''}"
Type: ${(tags || []).join(', ') || 'none'}
Description: "${(description || '').slice(0, 300)}"
${avoid ? `\nAlready overused (avoid these): ${avoid}` : ''}

Rules:
- Reply with ONLY the single emoji character. No words, no punctuation, nothing else.
- Pick something that reflects the academic content or activity type.
- Prefer specific emojis over generic ones (e.g. 🧬 for genetics, 🌋 for geology).`;

    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.4, num_predict: 8 } }),
      timeout: 15000,
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data  = await r.json();
    const emoji = extractEmoji((data.response || '').trim()) || subjectFallback(className);
    res.json({ emoji });
  } catch (err) {
    console.warn('[ai] emoji error:', err.message);
    res.json({ emoji: subjectFallback(req.body?.class || ''), fallback: true });
  }
});

async function ollamaFallback(question) {
  const { prompt } = await buildAskPrompt(question);
  return askOllama(prompt, { num_predict: 384 });
}

async function buildAskPrompt(question) {
  const isDeep = /study plan|analyse|analysis|explain|describe|detail|tell me about|what is|how (does|do|can)|build me|prepare|summarize|compare/i.test(question);

  let notionTasks = [];
  try {
    const r = await fetch(buildNotionQueryUrl(question, isDeep), { timeout: 10000 });
    if (r.ok) notionTasks = await r.json();
  } catch {}

  let memories = [];
  try {
    const r = await fetch(`${MEMPALACE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: question, limit: 5 }),
      timeout: 5000,
    });
    if (r.ok) memories = (await r.json()).results || [];
  } catch {}

  const parts = [];
  if (notionTasks.length) {
    parts.push('## Levan\'s Tasks\n' + formatTasks(prioritizeTasks(notionTasks, question, isDeep), isDeep));
  }
  if (memories.length) {
    parts.push('## Previous Conversations\n' + memories.map(m => m.text || m.content || '').join('\n\n'));
  }

  let ctx = parts.join('\n\n');
  if (ctx.length > CONTEXT_CHAR_LIMIT) ctx = ctx.slice(0, CONTEXT_CHAR_LIMIT);

  return {
    prompt: ctx
      ? `You are Genesis, a helpful AI for Levan — an IB high school student. Answer concisely using the data below.\n\n${ctx}\n\n---\n\nQuestion: ${question}\n\nAnswer:`
      : `You are Genesis, a helpful AI for Levan — an IB high school student.\n\nQuestion: ${question}\n\nAnswer:`
  };
}

function buildNotionQueryUrl(question, isDeep) {
  const q = String(question || '').trim();

  if (/\bdue\s+today\b|\btoday\b|\btonight\b/i.test(q)) {
    return `${NOTION_URL}/tasks?date=today&detail=${isDeep}`;
  }
  if (/\boverdue\b|\bmissing\b|\bpast due\b/i.test(q)) {
    return `${NOTION_URL}/tasks?all=true&detail=${isDeep}`;
  }

  const className = extractClassName(q);
  if (className) {
    return `${NOTION_URL}/tasks?class=${encodeURIComponent(className)}&detail=${isDeep}`;
  }

  const searchQuery = extractSearchQuery(q);
  if (searchQuery) {
    return `${NOTION_URL}/search?q=${encodeURIComponent(searchQuery)}`;
  }

  return `${NOTION_URL}/tasks?all=true&detail=${isDeep}`;
}

function extractClassName(question) {
  const knownClasses = [
    'Biology', 'Chemistry', 'History', 'English', 'Spanish', 'Mathematics',
    'Math', 'Theatre', 'Visual Arts', 'Geography', 'Digital Design', 'PE', 'Wellbeing'
  ];
  return knownClasses.find(name => new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').test(question)) || null;
}

function extractSearchQuery(question) {
  const cleaned = String(question || '')
    .replace(/\b(what|which|show|tell|me|about|is|are|due|today|tomorrow|for|my|the|a|an|do|i|have)\b/gi, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  return cleaned.split(' ').filter(w => w.length > 2).slice(0, 4).join(' ');
}

function prioritizeTasks(tasks, question, isDeep) {
  const now = Date.now();
  const query = String(question || '').toLowerCase();

  return [...tasks]
    .map(task => {
      const text = [task.title, task.name, task.class, ...(task.tags || [])].filter(Boolean).join(' ').toLowerCase();
      const dueRaw = task.due || task.due_date || null;
      const dueMs = dueRaw ? Date.parse(dueRaw) : Number.POSITIVE_INFINITY;
      let score = 0;

      if (Number.isFinite(dueMs)) {
        const distanceDays = Math.abs(dueMs - now) / 86400000;
        score += Math.max(0, 40 - distanceDays);
        if (dueMs >= now) score += 8;
      }
      if (task.submissionStatus && /submitted|complete|done/i.test(task.submissionStatus)) score -= 25;
      if (task.status && /complete|done/i.test(task.status)) score -= 25;
      for (const token of query.split(/\s+/).filter(Boolean)) {
        if (token.length > 2 && text.includes(token)) score += 6;
      }
      if (isDeep && task.description) score += 3;

      return { task, score, dueMs };
    })
    .sort((a, b) => b.score - a.score || a.dueMs - b.dueMs)
    .slice(0, MAX_CONTEXT_TASKS)
    .map(x => x.task);
}

function formatTasks(tasks, isDeep = false) {
  let total = 0;
  const lines = [];
  for (const t of tasks) {
    let line = `- ${t.title || t.name || 'Untitled'}`;
    if (t.due || t.due_date) line += ` (due: ${t.due || t.due_date})`;
    if (t.class) line += ` [${t.class}]`;
    if (t.status) line += ` — ${t.status}`;
    if (t.grades) line += ` — Grades: ${t.grades}`;
    if (t.submissionStatus) line += ` — Submission: ${t.submissionStatus}`;
    if (t.tags?.length) line += ` — ${t.tags.join(', ')}`;
    if (isDeep && t.description) line += `\n  Description: ${t.description.slice(0, TASK_DESC_LIMIT)}`;
    if (total + line.length > CONTEXT_CHAR_LIMIT * 0.7) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

const EMOJI_RE = /(\p{Emoji_Presentation}|\p{Emoji}️)/u;
function extractEmoji(str) {
  const m = (str || '').match(EMOJI_RE);
  return m ? m[0] : null;
}

const SUBJECT_FALLBACK = [
  [/biology/i, '🔬'], [/chemistry/i, '⚗️'], [/physics/i, '⚡'],
  [/math/i, '📐'], [/english|literature/i, '📖'], [/spanish|language/i, '🌍'],
  [/history of georgia/i, '🏰'], [/history/i, '🏛️'], [/geography/i, '🗺️'],
  [/digital design/i, '💻'], [/theatre/i, '🎭'], [/visual arts/i, '🎨'],
  [/phe|physical|health/i, '🏃'], [/wellbeing/i, '🧠'], [/georgian/i, '🇬🇪'],
  [/homeroom/i, '🏫'], [/cultural/i, '🌐'],
];
function subjectFallback(cn) {
  for (const [re, e] of SUBJECT_FALLBACK) if (re.test(cn || '')) return e;
  return '📝';
}

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`[ai] running on port ${PORT} — primary: OpenClaw, fallback: Ollama`));
