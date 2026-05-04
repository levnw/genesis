require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const fetch   = require('node-fetch');
const { getClient, getAllPages, chunkText, findDuplicates, buildTaskMap } = require('./lib/notion');
const { syncAll, loadAllTasks, hashTask } = require('./lib/sync');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Sync all tasks from DATA_DIR to Notion ─────────────────────────────────
let _syncRunning = false;
let _syncStatus = { ok: false, message: 'No sync run yet' };

app.post('/sync', async (req, res) => {
  const force     = req.body?.force    || false;
  const classId   = req.body?.classId  || req.query.classId  || null;
  const period    = req.body?.period   || req.query.period   || null;  // 'today'|'week'|'upcoming'|null
  const startAt   = req.body?.startAt  ?? req.query.startAt  ?? 0;
  const limit     = req.body?.limit    ?? req.query.limit    ?? null;
  const asyncMode = req.query.async === 'true' || req.body?.async === true;

  const syncOpts = { force, classId, period, startAt, limit };

  if (asyncMode) {
    if (_syncRunning) {
      return res.status(409).json({ error: 'SYNC_IN_PROGRESS', message: 'A sync is already running. Poll GET /sync/status for progress.' });
    }

    _syncRunning = true;
    _syncStatus = { ok: true, running: true, started_at: new Date().toISOString(), ...syncOpts, message: 'Sync started.' };
    res.json({ ok: true, message: 'Sync started. Poll GET /sync/status for progress.' });

    syncAll(syncOpts)
      .then(result => {
        _syncStatus = { ...result, running: false };
        triggerEmojiAssignment().catch(err => console.warn('[notion] emoji error:', err.message));
      })
      .catch(err => {
        console.error('[notion] sync error:', err.message);
        _syncStatus = { ok: false, running: false, error: 'SYNC_FAILED', message: err.message, finished_at: new Date().toISOString() };
      })
      .finally(() => {
        _syncRunning = false;
        if (_syncStatus && !_syncStatus.finished_at) _syncStatus.finished_at = new Date().toISOString();
      });
    return;
  }

  try {
    const result = await syncAll(syncOpts);
    // Always run emoji assignment after sync (fire-and-forget)
    triggerEmojiAssignment().catch(err => console.warn('[notion] emoji error:', err.message));
    res.json(result);
  } catch (err) {
    console.error('[notion] sync error:', err.message);
    res.status(500).json({ error: 'SYNC_FAILED', message: err.message });
  }
});

app.get('/sync/status', (req, res) => {
  res.json(_syncStatus);
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

// ── Deduplicate Notion pages ───────────────────────────────────────────────
// GET  /dedupe        → preview what would be removed (dry run)
// POST /dedupe        → actually archive duplicates
app.get('/dedupe', async (req, res) => {
  try {
    const notion = getClient();
    const dbId   = process.env.NOTION_TASKS_DB;
    const dupes  = await findDuplicates(notion, dbId);
    const total  = dupes.reduce((n, d) => n + d.remove.length, 0);
    res.json({ duplicateGroups: dupes.length, pagesToRemove: total, preview: dupes });
  } catch (err) {
    res.status(500).json({ error: 'DEDUPE_FAILED', message: err.message });
  }
});

app.post('/dedupe', async (req, res) => {
  try {
    const notion = getClient();
    const dbId   = process.env.NOTION_TASKS_DB;
    const dupes  = await findDuplicates(notion, dbId);

    // Respond immediately and stream progress — archiving 200+ pages takes a while
    res.setHeader('Content-Type', 'application/json');

    let removed = 0, errors = 0;
    const BATCH_PAUSE = 350; // ms between API calls to stay under rate limit

    for (const { keep, keepTitle, remove } of dupes) {
      for (const pageId of remove) {
        try {
          await notion.pages.update({ page_id: pageId, archived: true });
          removed++;
        } catch (err) {
          errors++;
          console.warn(`[notion] dedupe archive failed for ${pageId}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, BATCH_PAUSE));
      }
    }

    res.json({ ok: true, duplicateGroupsFixed: dupes.length, pagesRemoved: removed, errors });
  } catch (err) {
    res.status(500).json({ error: 'DEDUPE_FAILED', message: err.message });
  }
});

// ── Debug — understand sync state ─────────────────────────────────────────
// GET /debug → shows local tasks vs Notion, missing pages, stale hashes, duplicates
app.get('/debug', async (req, res) => {
  try {
    const notion   = getClient();
    const dbId     = process.env.NOTION_TASKS_DB;
    const taskMap  = await buildTaskMap(notion, dbId);
    const dupes    = await findDuplicates(notion, dbId);
    const local    = loadAllTasks();

    const report = {
      local_tasks:      local.length,
      notion_pages:     taskMap.size,
      duplicate_groups: dupes.length,
      duplicates:       dupes.map(d => ({ title: d.keepTitle, url: d.url, extra_copies: d.remove.length })),
      missing_in_notion: [],   // local tasks with no Notion page
      stale_hash:        [],   // tasks where hash changed (would update on next sync)
      no_url:            [],   // Notion pages without a URL (can't be matched)
    };

    for (const task of local) {
      if (!task.managebac_url) continue;
      const notionEntry = taskMap.get(task.managebac_url);
      if (!notionEntry) {
        report.missing_in_notion.push({ id: task.id, name: task.name, class: task.class_name });
      } else {
        const currentHash = hashTask(task);
        if (notionEntry.genesisHash && notionEntry.genesisHash !== currentHash) {
          report.stale_hash.push({ id: task.id, name: task.name, class: task.class_name, note: 'will update on next sync' });
        }
      }
    }

    // Check for Notion pages without URL (orphans)
    const allPages = await getAllPages(notion, dbId);
    for (const page of allPages) {
      const url = page.properties?.URL?.url?.trim();
      if (!url) {
        report.no_url.push({
          pageId: page.id,
          title:  page.properties?.Name?.title?.[0]?.plain_text || '(untitled)',
        });
      }
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'DEBUG_FAILED', message: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`[notion] running on port ${PORT}`));
