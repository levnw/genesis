require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const fetch   = require('node-fetch');
const { getClient, getAllPages, chunkText } = require('./lib/notion');
const { syncAll, loadAllTasks } = require('./lib/sync');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Sync all tasks from DATA_DIR to Notion ─────────────────────────────────
app.post('/sync', async (req, res) => {
  try {
    const result = await syncAll({ force: req.body?.force || false });

    // After sync, trigger emoji assignment via ai/ service (fire-and-forget)
    const aiUrl = process.env.AI_SERVICE_URL;
    if (aiUrl && result.created > 0) {
      triggerEmojiAssignment(result).catch(err =>
        console.warn('[notion] emoji assignment error:', err.message)
      );
    }

    res.json(result);
  } catch (err) {
    console.error('[notion] sync error:', err.message);
    res.status(500).json({ error: 'SYNC_FAILED', message: err.message });
  }
});

// ── Sync a single task by taskId ───────────────────────────────────────────
app.post('/sync/task', async (req, res) => {
  try {
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'MISSING_TASK_ID', message: 'taskId required' });

    const tasks = loadAllTasks();
    const task  = tasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND', message: `No task with id "${taskId}"` });

    const notion  = getClient();
    const { buildTaskMap } = require('./lib/notion');
    const taskMap = await buildTaskMap(notion, process.env.NOTION_TASKS_DB);
    const { syncTask } = require('./lib/sync');
    const r = await syncTask(notion, task, taskMap);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[notion] sync/task error:', err.message);
    res.status(500).json({ error: 'SYNC_TASK_FAILED', message: err.message });
  }
});

// ── Query tasks ────────────────────────────────────────────────────────────
app.get('/tasks', async (req, res) => {
  try {
    const notion = getClient();
    const dbId   = process.env.NOTION_TASKS_DB;
    if (!dbId) return res.status(500).json({ error: 'NOTION_TASKS_DB not set' });

    const { class: className, date, all, detail } = req.query;
    const isDetail = detail === 'true';

    // Build filter
    const filters = [];
    if (date === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      filters.push({ property: 'Due Date', date: { equals: today } });
    }
    if (className) {
      filters.push({ property: 'Class', select: { equals: className } });
    }

    const filter = filters.length === 0 ? undefined
      : filters.length === 1 ? filters[0]
      : { and: filters };

    const pages = await getAllPages(notion, dbId, filter);

    const tasks = await Promise.all(pages.map(async (page) => {
      const props = page.properties;

      const task = {
        id:               page.id,
        title:            props?.Name?.title?.[0]?.plain_text || '',
        due:              props?.['Due Date']?.date?.start || null,
        status:           props?.Assessment?.select?.name || null,
        submissionStatus: props?.Submission?.select?.name || null,
        class:            props?.Class?.select?.name || null,
        tags:             (props?.Category?.multi_select || []).map(t => t.name),
        grades:           props?.Grades?.rich_text?.[0]?.plain_text || null,
        teacherComment:   props?.['Teacher Comment']?.rich_text?.[0]?.plain_text || null,
        url:              props?.URL?.url || null,
        lastEdited:       page.last_edited_time || null,
      };

      if (isDetail) {
        // Fetch body blocks (description content)
        const { getBlocks } = require('./lib/notion');
        const blocks = await getBlocks(notion, page.id);

        // Separate body blocks from attachment sub-pages
        const bodyBlocks = [];
        const attachmentSubPages = [];

        for (const block of blocks) {
          if (block.type === 'child_page') {
            const subTitle = block.child_page?.title || '';
            if (subTitle.startsWith('📎')) {
              attachmentSubPages.push({ pageId: block.id, title: subTitle });
            }
          } else {
            const text = extractBlockText(block);
            if (text) bodyBlocks.push(text);
          }
        }

        task.description = bodyBlocks.join('\n').trim();
        task.attachments = attachmentSubPages;
      }

      return task;
    }));

    res.json(tasks);
  } catch (err) {
    console.error('[notion] tasks error:', err.message);
    res.status(500).json({ error: 'TASKS_FAILED', message: err.message });
  }
});

// ── Get attachment text for a specific task ────────────────────────────────
app.get('/tasks/:id/attachments', async (req, res) => {
  try {
    const notion = getClient();
    const blocks = await require('./lib/notion').getBlocks(notion, req.params.id);

    const attachments = [];
    for (const block of blocks) {
      if (block.type !== 'child_page') continue;
      const title = block.child_page?.title || '';
      if (!title.startsWith('📎')) continue;

      // Fetch sub-page content
      const subBlocks = await require('./lib/notion').getBlocks(notion, block.id);
      const text = subBlocks.map(b => extractBlockText(b)).filter(Boolean).join('\n');
      attachments.push({ title, text });
    }

    res.json(attachments);
  } catch (err) {
    res.status(500).json({ error: 'ATTACHMENTS_FAILED', message: err.message });
  }
});

// ── Search pages by keyword ────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'MISSING_QUERY', message: 'q is required' });

    const notion = getClient();
    const dbId   = process.env.NOTION_TASKS_DB;

    const filter = { property: 'Name', title: { contains: q } };
    const pages  = await getAllPages(notion, dbId, filter);

    const results = pages.map(page => ({
      id:    page.id,
      title: page.properties?.Name?.title?.[0]?.plain_text || '',
      due:   page.properties?.['Due Date']?.date?.start || null,
      class: page.properties?.Class?.select?.name || null,
      url:   page.properties?.URL?.url || null,
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'SEARCH_FAILED', message: err.message });
  }
});

// ── Append a note block to a Notion page ─────────────────────────────────
app.post('/note', async (req, res) => {
  try {
    const { pageId, text } = req.body || {};
    if (!pageId || !text) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'pageId and text are required' });
    }

    const notion   = getClient();
    const chunks   = chunkText(text, 1700);
    const children = chunks.map(chunk => ({
      object: 'block', type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '🗒️' },
        rich_text: [{ type: 'text', text: { content: chunk } }],
        color: 'gray_background',
      },
    }));

    await notion.blocks.children.append({ block_id: pageId, children });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'NOTE_FAILED', message: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function extractBlockText(block) {
  const richText = block[block.type]?.rich_text || [];
  return richText.map(rt => rt.plain_text || '').join('');
}

async function triggerEmojiAssignment(syncResult) {
  const tasks = loadAllTasks().filter(t => t.notion_page_id && !t.emoji);
  const aiUrl = process.env.AI_SERVICE_URL;
  if (!aiUrl || !tasks.length) return;

  // Group by class for anti-repetition
  const byClass = {};
  for (const t of tasks) {
    const cls = t.class_name || 'unknown';
    if (!byClass[cls]) byClass[cls] = [];
    byClass[cls].push(t);
  }

  for (const [className, classTasks] of Object.entries(byClass)) {
    const usedEmojis = classTasks.filter(t => t.emoji).map(t => t.emoji);

    for (const task of classTasks) {
      if (task.emoji) continue;
      try {
        const r = await fetch(`${aiUrl}/emoji`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: task.name, class: className,
            tags: task.tags, description: task.description?.slice(0, 300),
            usedEmojis,
          }),
          timeout: 15000,
        });
        if (!r.ok) continue;
        const { emoji } = await r.json();
        if (!emoji) continue;

        // Set emoji on Notion page
        const notion = getClient();
        await notion.pages.update({ page_id: task.notion_page_id, icon: { type: 'emoji', emoji } });
        usedEmojis.push(emoji);

        // Save to local task JSON
        const taskFile = require('path').join(
          process.env.DATA_DIR || '../data',
          'classes', task.class_id, 'tasks', `${task.id}.json`
        );
        const updated = { ...task, emoji };
        require('fs').writeFileSync(taskFile, JSON.stringify(updated, null, 2));
      } catch (err) {
        console.warn(`[notion] emoji failed for "${task.name}": ${err.message}`);
      }
    }
  }
}

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`[notion] running on port ${PORT}`));
