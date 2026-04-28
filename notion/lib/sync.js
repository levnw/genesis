'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getClient, buildTaskMap, buildTaskProperties, chunkText } = require('./notion');

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
      await notion.pages.create({
        parent: { page_id: pageId },
        icon: { type: 'emoji', emoji: '📎' },
        properties: { title: [{ text: { content: subPageTitle } }] },
        children: children.slice(0, 100),
      });
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

  const existing = taskMap.get(task.managebac_url);

  if (existing) {
    // Conflict protection: if genesis_hash differs from what we stored, user edited it
    const lastHash = existing.genesisHash;
    if (lastHash && lastHash !== hash && !force) {
      // Only update fields we know haven't been touched
      // Safe fields: Submission, Assessment, Grades, Teacher Comment (rarely manually edited)
      const safeProps = {};
      const newProps = buildTaskProperties(task);

      // Always update: Submission, Assessment, Grades, Teacher Comment (factual data)
      for (const field of ['Submission', 'Assessment', 'Grades', 'Teacher Comment', 'genesis_hash']) {
        if (newProps[field]) safeProps[field] = newProps[field];
      }

      if (Object.keys(safeProps).length > 0) {
        await notion.pages.update({ page_id: existing.pageId, properties: safeProps });
      }
      return { action: 'partial_update', pageId: existing.pageId };
    }

    // Full update — either force or hash matches (no user edits)
    const props = buildTaskProperties(task);
    await notion.pages.update({ page_id: existing.pageId, properties: props });
    taskMap.set(task.managebac_url, { ...existing, genesisHash: hash });
    return { action: 'updated', pageId: existing.pageId };
  }

  // Create new page
  const props = buildTaskProperties(task);
  const page  = await notion.pages.create({
    parent: { database_id: dbId },
    properties: props,
  });

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

  const tasks   = loadAllTasks(options.classId || null);
  const taskMap = await buildTaskMap(notion, dbId);

  const results = { created: 0, updated: 0, partial: 0, failed: 0 };

  for (const task of tasks) {
    try {
      const r = await syncTask(notion, task, taskMap, options);
      if (r.action === 'created') {
        results.created++;
        saveTask({ ...task, notion_page_id: r.pageId });
      } else if (r.action === 'updated') {
        results.updated++;
        saveTask({ ...task, notion_page_id: r.pageId });
      } else if (r.action === 'partial_update') {
        results.partial++;
      }
    } catch (err) {
      console.error(`[notion] sync failed for "${task.name}": ${err.message}`);
      results.failed++;
    }
  }

  return { ok: true, ...results, total: tasks.length, synced_at: new Date().toISOString() };
}

module.exports = { syncAll, syncTask, loadAllTasks, hashTask };
