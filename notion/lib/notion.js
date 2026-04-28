'use strict';

// Core Notion API helpers — adapted from managebac-backend/lib/notion.js
const { Client }  = require('@notionhq/client');
const fs          = require('fs');
const path        = require('path');

function getClient() {
  return new Client({ auth: process.env.NOTION_API_KEY });
}

async function getAllPages(notion, databaseId, filter = null) {
  const pages = [];
  let cursor;
  do {
    const query = { database_id: databaseId, start_cursor: cursor, page_size: 100 };
    if (filter) query.filter = filter;
    const res = await notion.databases.query(query);
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function getBlocks(notion, pageId) {
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function buildTaskMap(notion, databaseId) {
  const map = new Map();
  const pages = await getAllPages(notion, databaseId);
  for (const page of pages) {
    const url = page.properties?.URL?.url?.trim();
    if (url) {
      map.set(url, {
        pageId:      page.id,
        title:       page.properties?.Name?.title?.[0]?.plain_text || '',
        lastEdited:  page.last_edited_time || null,
        icon:        page.icon?.type === 'emoji' ? page.icon.emoji : null,
        genesisHash: page.properties?.['genesis_hash']?.rich_text?.[0]?.plain_text || null,
        userEdited:  page.properties?.['user_edited']?.checkbox || false,
      });
    }
  }
  return map;
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

function buildTaskProperties(task) {
  const dueIso = task.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : null;
  const cls = safeSelect(task.class_name || null);

  const grades = task.criterionGrades || {};
  const gradeParts = ['A','B','C','D']
    .filter(l => grades[l]?.score != null)
    .map(l => `${l}: ${grades[l].score}/${grades[l].max ?? 8}`);

  return {
    Name:       { title: [{ text: { content: (task.name || 'Untitled').slice(0, 2000) } }] },
    'Due Date': dueIso ? { date: { start: dueIso } } : undefined,
    Category:   task.tags?.length ? { multi_select: task.tags.map(t => ({ name: t })) } : undefined,
    Class:      cls ? { select: { name: cls } } : undefined,
    URL:        task.managebac_url ? { url: task.managebac_url } : undefined,
    Submission: task.submissionStatus ? { select: { name: task.submissionStatus } } : undefined,
    Assessment: task.assessmentStatus ? { select: { name: task.assessmentStatus } } : undefined,
    Grades:     gradeParts.length ? { rich_text: [{ text: { content: gradeParts.join(' · ') } }] } : undefined,
    'Teacher Comment': task.teacher_comment
      ? { rich_text: [{ text: { content: task.teacher_comment.slice(0, 2000) } }] }
      : undefined,
    'genesis_hash': { rich_text: [{ text: { content: task._genesisHash || '' } }] },
  };
}

module.exports = { getClient, getAllPages, getBlocks, buildTaskMap, chunkText, safeSelect, buildTaskProperties };
