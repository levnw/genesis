require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express  = require('express');
const OpenAI   = require('openai');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

const NOTION_URL    = process.env.NOTION_SERVICE_URL || 'http://localhost:3002';
const MEMPALACE_URL = process.env.MEMPALACE_URL || 'http://localhost:8765';
const GPT_MODEL     = process.env.OPENAI_MODEL || 'gpt-4o';
const OLLAMA_URL    = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL || 'llama3.2';

// Context budget: ~8,000 tokens ≈ 32,000 chars
const CONTEXT_CHAR_LIMIT = 32000;
const TASK_DESC_LIMIT    = 1500;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Ask ────────────────────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: 'MISSING_QUESTION', message: 'question is required' });

    // Classify question complexity: deep if it asks for plans, study, analysis, details
    const isDeep = /study plan|analyse|analysis|explain|describe|detail|tell me about|what is|how (does|do|can)|build me|prepare|summarize|compare/i.test(question);
    const searchQuery = extractSearchQuery(question);

    // Fetch Notion context
    let notionTasks = [];
    try {
      const url = searchQuery
        ? `${NOTION_URL}/search?q=${encodeURIComponent(searchQuery)}`
        : `${NOTION_URL}/tasks?detail=${isDeep}`;
      const r = await fetch(url, { timeout: 10000 });
      if (r.ok) notionTasks = await r.json();
    } catch (err) {
      console.warn('[ai] Notion fetch failed:', err.message);
    }

    // Retrieve memories
    let memories = [];
    try {
      const r = await fetch(`${MEMPALACE_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question, limit: 5 }),
        timeout: 5000,
      });
      if (r.ok) memories = (await r.json()).results || [];
    } catch { /* MemPalace optional */ }

    // Build context string within budget
    const contextParts = [];

    if (notionTasks.length > 0) {
      contextParts.push('## Your Tasks\n' + formatTasksForContext(notionTasks, isDeep));
    }
    if (memories.length > 0) {
      contextParts.push('## Previous Conversations\n' + memories.map(m => m.text || m.content || '').join('\n\n'));
    }

    let context = contextParts.join('\n\n');
    let truncated = false;
    if (context.length > CONTEXT_CHAR_LIMIT) {
      context = context.slice(0, CONTEXT_CHAR_LIMIT);
      truncated = true;
    }

    // Call OpenAI
    const systemPrompt = buildSystemPrompt();
    const userMessage  = context
      ? `Context:\n${context}\n\n---\n\nQuestion: ${question}`
      : question;

    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const answer = response.choices[0]?.message?.content || '';

    // Store Q&A in memory (fire-and-forget)
    storeMemory(question, answer).catch(() => {});

    res.json({ answer, context_truncated: truncated });
  } catch (err) {
    console.error('[ai] ask error:', err.message);
    res.status(500).json({ error: 'ASK_FAILED', message: err.message });
  }
});

// ── Note (scratchpad) ──────────────────────────────────────────────────────
app.post('/note', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'MISSING_TEXT', message: 'text is required' });

    // Ask OpenAI to identify which task this refers to
    const parseResponse = await openai.chat.completions.create({
      model: GPT_MODEL,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'You are a task-reference extractor. Given a note about schoolwork, extract the task name or class name being referenced. Reply with ONLY a JSON object: {"taskName": "...", "className": "..."}. If you cannot identify a specific task, set the value to null.' },
        { role: 'user', content: text },
      ],
    });

    let taskName = null, className = null;
    try {
      const parsed = JSON.parse(parseResponse.choices[0]?.message?.content || '{}');
      taskName  = parsed.taskName  || null;
      className = parsed.className || null;
    } catch { /* fallback: search by full text */ }

    const searchQ = taskName || className || text.slice(0, 50);
    const r = await fetch(`${NOTION_URL}/search?q=${encodeURIComponent(searchQ)}`, { timeout: 8000 });
    if (!r.ok) return res.status(502).json({ error: 'NOTION_SEARCH_FAILED', message: 'Could not search Notion' });

    const results = await r.json();
    if (!results.length) {
      return res.status(404).json({ error: 'TASK_NOT_FOUND', message: `No task found matching "${searchQ}"` });
    }

    // Use first result
    const page = results[0];
    const noteR = await fetch(`${NOTION_URL}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: page.id, text }),
      timeout: 8000,
    });
    if (!noteR.ok) {
      return res.status(502).json({ error: 'NOTE_APPEND_FAILED', message: 'Could not append note to Notion' });
    }

    res.json({ ok: true, page: page.title });
  } catch (err) {
    console.error('[ai] note error:', err.message);
    res.status(500).json({ error: 'NOTE_FAILED', message: err.message });
  }
});

// ── Emoji (Ollama backend) ─────────────────────────────────────────────────
app.post('/emoji', async (req, res) => {
  try {
    const { title, class: className, tags, description, usedEmojis = [] } = req.body || {};

    const avoidList = usedEmojis
      .reduce((acc, e) => { acc[e] = (acc[e] || 0) + 1; return acc; }, {})
      ;
    const avoid = Object.entries(avoidList)
      .filter(([, count]) => count >= 3)
      .map(([emoji]) => emoji)
      .join(' ');

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

    if (!r.ok) throw new Error(`Ollama returned ${r.status}`);
    const data = await r.json();
    const raw  = (data.response || '').trim();
    const emoji = extractEmoji(raw) || subjectFallback(className);
    res.json({ emoji });
  } catch (err) {
    console.warn('[ai] emoji (Ollama) error:', err.message);
    const emoji = subjectFallback(req.body?.class || '');
    res.json({ emoji, fallback: true });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are Genesis — a personal AI assistant for a high school student.
You have access to their ManageBac tasks, Notion notes, and past conversations.

Your style:
- Concise and direct. No filler words or unnecessary preamble.
- Helpful and honest. If you don't know something, say so.
- School and life oriented — tasks, deadlines, study plans, general questions.

When answering questions about tasks:
- Reference specific task names and due dates when relevant.
- Flag anything overdue or due soon.
- Be practical, not generic.`;
}

function extractSearchQuery(question) {
  // Extract key subject/task keywords for Notion search
  const words = question.match(/\b[A-Z][a-z]+\b|\b(biology|chemistry|physics|math|english|spanish|history|geography|theatre|arts|design)\b/gi);
  return words ? words.slice(0, 3).join(' ') : '';
}

function formatTasksForContext(tasks, isDeep) {
  let total = 0;
  const lines = [];
  for (const task of tasks) {
    let line = `- ${task.title || task.name || 'Untitled'}`;
    if (task.due || task.due_date) line += ` (due: ${task.due || task.due_date})`;
    if (task.class) line += ` [${task.class}]`;
    if (task.status) line += ` — ${task.status}`;
    if (task.grades) line += ` — Grades: ${task.grades}`;
    if (task.submissionStatus) line += ` — Submission: ${task.submissionStatus}`;
    if (task.tags?.length) line += ` — ${task.tags.join(', ')}`;

    if (isDeep && task.description) {
      const desc = task.description.slice(0, TASK_DESC_LIMIT);
      line += `\n  Description: ${desc}`;
    }

    if (total + line.length > CONTEXT_CHAR_LIMIT * 0.7) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

async function storeMemory(question, answer) {
  await fetch(`${MEMPALACE_URL}/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Q: ${question}\nA: ${answer}` }),
    timeout: 5000,
  });
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
function subjectFallback(className) {
  for (const [re, emoji] of SUBJECT_FALLBACK) {
    if (re.test(className || '')) return emoji;
  }
  return '📝';
}

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`[ai] running on port ${PORT}`));
