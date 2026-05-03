'use strict';

// Core Notion API helpers — adapted from managebac-backend/lib/notion.js
const { Client }  = require('@notionhq/client');
const fs          = require('fs');
const path        = require('path');

function getClient() {
  return new Client({ auth: process.env.NOTION_API_KEY });
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
      delayMs *= 2;
    }
  }
}

async function getAllPages(notion, databaseId, filter = null) {
  const pages = [];
  let cursor;
  do {
    const query = { database_id: databaseId, start_cursor: cursor, page_size: 100 };
    if (filter) query.filter = filter;
    const res = await withNotionRetry(() => notion.databases.query(query), 'database query');
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function getBlocks(notion, pageId) {
  const blocks = [];
  let cursor;
  do {
    const res = await withNotionRetry(() => notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }), 'block list');
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function buildTaskMap(notion, databaseId) {
  const map = new Map();
  const duplicates = new Map(); // url → [pageId, pageId, ...]
  const pages = await getAllPages(notion, databaseId);

  for (const page of pages) {
    const url = page.properties?.URL?.url?.trim();
    if (!url) continue;

    const entry = {
      pageId:      page.id,
      title:       page.properties?.Name?.title?.[0]?.plain_text || '',
      lastEdited:  page.last_edited_time || null,
      icon:        page.icon?.type === 'emoji' ? page.icon.emoji : null,
      genesisHash: page.properties?.['genesis_hash']?.rich_text?.[0]?.plain_text || null,
    };

    if (map.has(url)) {
      // Duplicate found — track it
      if (!duplicates.has(url)) duplicates.set(url, [map.get(url).pageId]);
      duplicates.get(url).push(page.id);
      // Keep whichever has a genesis_hash (was synced by us), else keep newer
      const existing = map.get(url);
      if (!existing.genesisHash && entry.genesisHash) map.set(url, entry);
    } else {
      map.set(url, entry);
    }
  }

  if (duplicates.size > 0) {
    console.warn(`[notion] ⚠️  Found ${duplicates.size} duplicate URL(s) in Notion DB. Run POST /notion/dedupe to fix.`);
  }

  return map;
}

// Find all duplicate pages (same URL) in the DB.
// Returns array of { url, keep: pageId, remove: [pageId, ...] }
async function findDuplicates(notion, databaseId) {
  const seen = new Map(); // url → [pages]
  const pages = await getAllPages(notion, databaseId);

  for (const page of pages) {
    const url = page.properties?.URL?.url?.trim();
    if (!url) continue;
    if (!seen.has(url)) seen.set(url, []);
    seen.get(url).push(page);
  }

  const dupes = [];
  for (const [url, group] of seen) {
    if (group.length < 2) continue;
    // Pick the "best" one to keep:
    // 1. Has genesis_hash (was written by us)
    // 2. Has content (blocks / last edited most recently)
    group.sort((a, b) => {
      const aHash = a.properties?.['genesis_hash']?.rich_text?.[0]?.plain_text || '';
      const bHash = b.properties?.['genesis_hash']?.rich_text?.[0]?.plain_text || '';
      if (aHash && !bHash) return -1;
      if (!aHash && bHash) return 1;
      return new Date(b.last_edited_time) - new Date(a.last_edited_time);
    });
    dupes.push({ url, keep: group[0].id, keepTitle: group[0].properties?.Name?.title?.[0]?.plain_text || '', remove: group.slice(1).map(p => p.id) });
  }

  return dupes;
}

async function getDatabaseProperties(notion, databaseId) {
  const db = await withNotionRetry(() => notion.databases.retrieve({ database_id: databaseId }), 'database retrieve');
  return db.properties || {};
}

function chunkText(text, max = 1800) {
  const t = String(text ?? '').replace(/[ \t]+/g, ' ').trim();
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + max, t.length);
    if (end < t.length) {
      const lastSpace = t.lastIndexOf(' ', end);
      if (lastSpace > i + 200) end = lastSpace;
    }
    const chunk = t.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    i = end;
  }
  return chunks;
}

function safeSelect(name) {
  return name ? name.replace(/,/g, '') : name;
}

function buildTaskProperties(task, supportedProps = null) {
  const dueIso = task.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : null;
  const cls = safeSelect(task.class_name || null);

  const grades = task.criterionGrades || {};
  const gradeParts = ['A','B','C','D']
    .filter(l => grades[l]?.score != null)
    .map(l => `${l}: ${grades[l].score}/${grades[l].max ?? 8}`);

  const props = {
    Name:       { title: [{ text: { content: (task.name || 'Untitled').slice(0, 2000) } }] },
    'Due Date': dueIso ? { date: { start: dueIso } } : undefined,
    Category:   task.tags?.length ? { multi_select: task.tags.map(t => ({ name: t })) } : undefined,
    Class:      cls ? { select: { name: cls } } : undefined,
    URL:        task.managebac_url ? { url: task.managebac_url } : undefined,
    'Task ID':  task.id ? { rich_text: [{ text: { content: String(task.id).slice(0, 2000) } }] } : undefined,
    Status:     (task.submissionStatus || task.assessmentStatus)
      ? { select: { name: safeSelect(task.submissionStatus || task.assessmentStatus) } }
      : undefined,
    Submission: task.submissionStatus ? { select: { name: safeSelect(task.submissionStatus) } } : undefined,
    Assessment: task.assessmentStatus ? { select: { name: safeSelect(task.assessmentStatus) } } : undefined,
    Grades:     gradeParts.length ? { rich_text: [{ text: { content: gradeParts.join(' · ') } }] } : undefined,
    'Teacher Comment': task.teacher_comment
      ? { rich_text: [{ text: { content: task.teacher_comment.slice(0, 2000) } }] }
      : undefined,
    'genesis_hash': { rich_text: [{ text: { content: task._genesisHash || '' } }] },
  };

  const filtered = Object.fromEntries(
    Object.entries(props).filter(([key, value]) => value !== undefined && (!supportedProps || supportedProps[key]))
  );
  return filtered;
}

module.exports = { getClient, getAllPages, getBlocks, buildTaskMap, findDuplicates, getDatabaseProperties, chunkText, safeSelect, buildTaskProperties };
