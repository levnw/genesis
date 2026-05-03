'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getClient, buildTaskMap, getDatabaseProperties, buildTaskProperties, chunkText } = require('./notion');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}

function listDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
}

function loadAllTasks(classIdFilter = null) {
  const tasks = [];
  const classesDir = path.join(DATA_DIR, 'classes');
  const classIds = classIdFilter ? [classIdFilter] : listDir(classesDir);
  for (const classId of classIds) {
    const tasksDir = path.join(classesDir, classId, 'tasks');
    for (const file of listDir(tasksDir)) {
      if (!file.endsWith('.json')) continue;
      const task = readJson(path.join(tasksDir, file));
      if (task) tasks.push(task);
    }
  }
  return tasks;
}

function saveTask(task) {
  const taskFile = path.join(DATA_DIR, 'classes', task.class_id, 'tasks', `${task.id}.json`);
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  const tmp = taskFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
  fs.renameSync(tmp, taskFile);
}

function hashTask(task) {
  const relevant = {
    name: task.name, due_date: task.due_date, tags: task.tags,
    submissionStatus: task.submissionStatus, assessmentStatus: task.assessmentStatus,
    criterionGrades: task.criterionGrades, teacher_comment: task.teacher_comment,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withNotionRetry(fn, label = 'Notion request') {
  let delayMs = 1500;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || '');
      const isRateLimited = err?.code === 'rate_limited' || /rate limited/i.test(msg);
      if (!isRateLimited || attempt === 6) throw err;
      const retryAfterSec = Number(err?.headers?.get?.('retry-after') || 0);
      const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : delayMs;
      console.warn(`[notion] ${label} rate-limited; retrying in ${waitMs}ms (attempt ${attempt}/6)`);
      await sleep(waitMs);
      delayMs = Math.min(delayMs * 2, 60000);
    }
  }
}

// Convert local task attachments to AI-readable text sub-pages on Notion
async function processAttachments(notion, pageId, task) {
  const attachments = (task.attachments || []).filter(a => a.local_path && fs.existsSync(a.local_path));
  if (!attachments.length) return;

  const MAX_TEXT_SIZE = 50 * 1024; // 50KB

  for (const att of attachments) {
    const ext  = path.extname(att.local_path).toLowerCase();
    const size = fs.statSync(att.local_path).size;
    let textContent = null;

    if (ext === '.pdf' && size <= MAX_TEXT_SIZE) {
      try {
        const pdfParse = require('pdf-parse');
        const buffer   = fs.readFileSync(att.local_path);
        const parsed   = await pdfParse(buffer);
        textContent    = parsed.text?.trim() || null;
      } catch (err) {
        console.warn(`[notion] pdf-parse failed for ${att.name}: ${err.message}`);
      }
    } else if (['.txt', '.md'].includes(ext) && size <= MAX_TEXT_SIZE) {
      textContent = fs.readFileSync(att.local_path, 'utf8').trim();
    }

    const subPageTitle = `📎 ${att.name || path.basename(att.local_path)}`;
    const children = [];

    if (textContent) {
      for (const chunk of chunkText(textContent, 1700)) {
        children.push({
          object: 'block', type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
        });
        if (children.length >= 95) break; // Notion limit 100 children
      }
    } else {
      const noteText = att.url
        ? `Attachment too large or unsupported format. Original: ${att.url}`
        : `Attachment: ${att.name || 'file'}`;
      children.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: noteText } }] },
      });
      if (att.url) {
        children.push({
          object: 'block', type: 'bookmark',
          bookmark: { url: att.url },
        });
      }
    }

    try {
      await withNotionRetry(() => notion.pages.create({
        parent: { page_id: pageId },
        icon: { type: 'emoji', emoji: '📎' },
        properties: { title: [{ text: { content: subPageTitle } }] },
        children: children.slice(0, 100),
      }), `attachment sub-page ${subPageTitle}`);
      await sleep(350);
    } catch (err) {
      console.warn(`[notion] Failed to create attachment sub-page "${subPageTitle}": ${err.message}`);
    }
  }
}

async function syncTask(notion, task, taskMap, options = {}) {
  const { force = false } = options;
  const dbId    = process.env.NOTION_TASKS_DB;
  const hash    = hashTask(task);
  task._genesisHash = hash;

  const supportedProps = options.supportedProps || await getDatabaseProperties(notion, dbId);
  const existing = taskMap.get(task.managebac_url);

  if (existing) {
    // Skip if nothing changed and not forced
    if (!force && existing.genesisHash === hash) {
      return { action: 'skipped', pageId: existing.pageId };
    }

    // Data changed (or force) — always do a full update
    const props = buildTaskProperties(task, supportedProps);
    await withNotionRetry(() => notion.pages.update({ page_id: existing.pageId, properties: props }), `update ${task.name}`);
    taskMap.set(task.managebac_url, { ...existing, genesisHash: hash });
    return { action: 'updated', pageId: existing.pageId };
  }

  // Create new page
  const props = buildTaskProperties(task, supportedProps);
  const page  = await withNotionRetry(() => notion.pages.create({
    parent: { database_id: dbId },
    properties: props,
  }), `create ${task.name}`);

  taskMap.set(task.managebac_url, {
    pageId: page.id, title: task.name, genesisHash: hash, icon: null,
  });

  // Process attachments (creates sub-pages)
  await processAttachments(notion, page.id, task);

  return { action: 'created', pageId: page.id };
}

async function syncAll(options = {}) {
  const notion = getClient();
  const dbId   = process.env.NOTION_TASKS_DB;
  if (!dbId) throw new Error('NOTION_TASKS_DB not configured');

  const allTasks = loadAllTasks(options.classId || null);
  const startAt  = Math.max(0, Number(options.startAt || 0));
  const limit    = options.limit != null ? Math.max(1, Number(options.limit)) : null;
  const tasks    = (limit ? allTasks.slice(startAt, startAt + limit) : allTasks.slice(startAt));
  const taskMap        = await buildTaskMap(notion, dbId);
  const supportedProps = await getDatabaseProperties(notion, dbId);

  const results = { created: 0, updated: 0, skipped: 0, failed: 0, startAt, processed: 0, remaining: Math.max(0, allTasks.length - startAt - tasks.length) };

  for (const task of tasks) {
    try {
      const r = await syncTask(notion, task, taskMap, { ...options, supportedProps });
      if (r.action === 'created') {
        results.created++;
        saveTask({ ...task, notion_page_id: r.pageId });
      } else if (r.action === 'updated') {
        results.updated++;
        saveTask({ ...task, notion_page_id: r.pageId });
      } else if (r.action === 'skipped') {
        results.skipped++;
      }
      results.processed++;
      await sleep(350);
    } catch (err) {
      console.error(`[notion] sync failed for "${task.name}": ${err.message}`);
      results.failed++;
      results.processed++;
    }
  }

  return { ok: true, ...results, total: allTasks.length, batchSize: tasks.length, synced_at: new Date().toISOString() };
}

module.exports = { syncAll, syncTask, loadAllTasks, hashTask };
