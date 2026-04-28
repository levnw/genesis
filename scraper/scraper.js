'use strict';

const { chromium } = require('playwright');
const fs  = require('fs');
const path = require('path');
const fsi = require('./lib/fs');
const classesLib = require('./lib/classes');
const tasksLib = require('./lib/tasks');
const { MB_BASE_URL } = require('./login');

const SPEED_PRESETS = {
  slow:   { concurrency: 1, taskDelay: 2000 },
  medium: { concurrency: 2, taskDelay: 700  },
  fast:   { concurrency: 3, taskDelay: 0    },
};

function isLoginPage(url) {
  return /\/(login|sign_in)(\/|$|\?)/.test(url);
}

async function loadWithRetry(page, url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return true;
    } catch {
      if (i === attempts) return false;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
}

async function scrapeTaskPage(page, fullUrl, context, taskIdFromUrl) {
  const loaded = await loadWithRetry(page, fullUrl);
  if (!loaded) throw new Error('load failed after 3 attempts');
  await settle(page);

  const showMore = page.getByText(/^Show More$/i).first();
  if (await showMore.isVisible().catch(() => false)) {
    await showMore.click().catch(() => {});
    await settle(page);
  }

  const data = await page.evaluate(() => {
    const norm = s => (s || '').replace(/[ \t]+/g, ' ').trim();
    const container = document.querySelector('.fusion-card') ||
      document.querySelector('.assignment-details') ||
      document.querySelector('main') || document.body;

    const title = norm(container.querySelector('h1, h2')?.textContent);

    function parseDueDate() {
      const badge = container.querySelector('.date-badge');
      if (badge) {
        const monthMap = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
        const month = monthMap[badge.querySelector('.month')?.textContent?.trim()];
        const day   = parseInt(badge.querySelector('.day')?.textContent?.trim(), 10);
        if (month && !isNaN(day)) {
          const dueText = container.querySelector('.due-date .due')?.textContent?.trim() || '';
          const timeMatch = dueText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          let hour = 0, min = 0;
          if (timeMatch) {
            hour = parseInt(timeMatch[1], 10);
            min  = parseInt(timeMatch[2], 10);
            if (timeMatch[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
            if (timeMatch[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
          }
          return new Date(new Date().getFullYear(), month - 1, day, hour, min).toISOString();
        }
      }
      const timeEl = container.querySelector('time[datetime]');
      if (timeEl) return timeEl.getAttribute('datetime');
      const dueEl = container.querySelector('.due-date .due, .due-date, .assignment-due-date');
      return dueEl ? norm(dueEl.textContent) : null;
    }

    const ALLOWED_TAGS = ['Formative','Summative','Test','Exam','Homework','Classwork','Quiz','Project','Assessment'];
    const tags = Array.from(container.querySelectorAll('.labels-set .label, .labels-set .badge'))
      .map(el => norm(el.textContent))
      .filter(t => t && t.length < 40)
      .filter(tag => ALLOWED_TAGS.some(a => tag.toLowerCase().includes(a.toLowerCase())));

    const descBlock = container.querySelector('.fr-view, .rich-text, .markdown, .wysiwyg, .description');
    const description      = descBlock ? descBlock.innerText.trim() : null;
    const description_html = descBlock ? descBlock.innerHTML : null;

    const cleanName = raw => norm(raw).replace(/\s*\d+(\.\d+)?\s*(B|KB|MB|GB)\s*$/i, '').trim();
    const attachments = Array.from(container.querySelectorAll('a[href]'))
      .map(a => {
        const rawName = Array.from(a.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent).join('');
        return { name: cleanName(rawName), url: a.href };
      })
      .filter(x => x.url && (
        x.url.includes('/uploads/') || x.url.includes('/attachments/') ||
        x.url.match(/\.(pdf|doc|docx|ppt|pptx|xls|xlsx|png|jpg|jpeg)\b/i)
      ))
      .map(x => ({ name: x.name || 'Attachment', url: x.url }));

    const teacherCommentEl = container.querySelector(
      '.teacher-comment, .teacher-feedback, [class*="teacher-comment"], [class*="teacher-feedback"], .f-comment__body'
    );
    const teacher_comment = teacherCommentEl
      ? norm(teacherCommentEl.innerText || teacherCommentEl.textContent).slice(0, 2000) || null
      : null;

    return { url: location.href, name: title || null, due_date: parseDueDate(),
      tags: [...new Set(tags)], description, description_html, attachments, teacher_comment };
  });

  // Download attachments locally
  const attDir = path.join(fsi.dataDir(), 'attachments_tmp', taskIdFromUrl);
  fsi.ensureDir(attDir);
  const mimeToExt = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };
  let attIndex = 0;
  for (const att of data.attachments) {
    try {
      const response = await context.request.get(att.url, { timeout: 30000 });
      if (!response.ok()) continue;
      const contentType = (response.headers()['content-type'] || '').split(';')[0].trim();
      if (contentType.startsWith('text/html')) continue;
      const buffer = await response.body();
      const extFromUrl = (att.url.match(/\.([a-z0-9]{1,5})(\?|#|$)/i) || [])[1];
      const ext   = extFromUrl || mimeToExt[contentType] || 'bin';
      const fname = `att${attIndex}.${ext}`;
      const fpath = path.join(attDir, fname);
      fs.writeFileSync(fpath, buffer);
      att.local_path   = fpath;
      att.mimeType     = contentType;
      att.local_name   = fname;
      attIndex++;
    } catch { /* skip failed downloads */ }
  }

  return data;
}

async function scrapeClass(context, cls, taskDelay, taskTimeoutMs, taskConcurrency) {
  const listUrl = `${MB_BASE_URL}/student/classes/${cls.managebac_class_id}/core_tasks?filter=all`;
  const listPage = await context.newPage();

  try {
    const loaded = await loadWithRetry(listPage, listUrl);
    if (!loaded) throw new Error(`Could not load class page: ${listUrl}`);
    await settle(listPage);
    if (isLoginPage(listPage.url())) throw new Error('Session expired');
  } catch (err) {
    await listPage.close().catch(() => {});
    throw err;
  }

  async function harvestListPage(evaluate) {
    return evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const items = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href || !/\/core_tasks\/\d+$/.test(href)) return;

        let row = a.parentElement;
        for (let i = 0; i < 15; i++) {
          if (!row || row === document.body) break;
          const tag = row.tagName;
          const cls = (row.className || '').toLowerCase();
          if (tag === 'LI' || tag === 'TR') break;
          if (cls.includes('item') || cls.includes('-row') || cls.includes('task-')) break;
          row = row.parentElement;
        }

        const tags = Array.from(row?.querySelectorAll('.labels-set .label') || [])
          .map(el => norm(el.textContent)).filter(t => t && t.length < 40);

        const badge     = row?.querySelector('.badge, .label-status, span.label');
        const badgeText = badge ? norm(badge.textContent).toLowerCase() : null;
        const badgeCls  = badge ? (badge.className || '') : '';

        let submissionStatus;
        if (!badge) {
          submissionStatus = 'No Dropbox';
        } else if (badgeCls.includes('warning') || badgeCls.includes('orange') || badgeText?.includes('late')) {
          submissionStatus = 'Late';
        } else if (badgeCls.includes('success') || badgeCls.includes('green') ||
                   badgeText?.includes('submitted') || badgeText?.includes('turned in')) {
          submissionStatus = 'Submitted';
        } else {
          submissionStatus = 'Pending';
        }

        const hasGradePills = !!(row?.querySelector('.criterion-grade'));
        let assessmentStatus = null;
        if (hasGradePills) {
          assessmentStatus = 'Graded';
        } else {
          const allEls = Array.from(row?.querySelectorAll('span,div,td,li,p') || []);
          const incEl = allEls.find(el => {
            const c = (el.className || '').toLowerCase();
            const t = norm(el.textContent).toLowerCase();
            return c.includes('incomplete') || (t === 'incomplete' && (el.children?.length || 0) === 0);
          });
          if (incEl) {
            assessmentStatus = 'Incomplete';
          } else {
            const comEl = allEls.find(el => {
              const c = (el.className || '').toLowerCase();
              const t = norm(el.textContent).toLowerCase();
              return (c.includes('complete') && !c.includes('incomplete')) ||
                     (t === 'complete' && (el.children?.length || 0) === 0);
            });
            assessmentStatus = comEl ? 'Complete' : null;
          }
        }

        // Criterion grades from list page
        const criterionGrades = {};
        row?.querySelectorAll('.criterion-grade').forEach(el => {
          const m = norm(el.textContent).match(/^([A-D])\s*:\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/i);
          if (m) criterionGrades[m[1].toUpperCase()] = { score: parseFloat(m[2]), max: parseFloat(m[3]) };
        });

        items.push({ href, name: norm(a.textContent) || null, tags, submissionStatus, assessmentStatus, criterionGrades });
      });
      return items;
    });
  }

  const taskLinks = await harvestListPage(listPage.evaluate.bind(listPage));

  // Paginate
  let morePages = true;
  while (morePages) {
    const loadMoreSel = 'a.pagination-next:not(.disabled), .pagination .next:not(.disabled), a[rel="next"]';
    const hasMore = await listPage.$(loadMoreSel).catch(() => null);
    if (!hasMore) { morePages = false; break; }
    await hasMore.click();
    await settle(listPage);
    const newItems = await harvestListPage(listPage.evaluate.bind(listPage));
    const existing = new Set(taskLinks.map(x => x.href));
    const added = newItems.filter(x => !existing.has(x.href));
    taskLinks.push(...added);
    if (added.length === 0) morePages = false;
  }
  await listPage.close();

  const seen = new Set();
  const uniqueLinks = taskLinks.filter(x => seen.has(x.href) ? false : (seen.add(x.href), true));
  console.log(`[scraper]   ${uniqueLinks.length} task(s) in ${cls.name}`);

  const queue = [...uniqueLinks];
  const freshTasks = [];

  async function taskWorker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { href, name: listName, tags: listTags, submissionStatus, assessmentStatus, criterionGrades } = item;
      const fullUrl       = href.startsWith('http') ? href : `${MB_BASE_URL}${href}`;
      const taskIdFromUrl = (fullUrl.match(/\/core_tasks\/(\d+)/) || [])[1] || String(Date.now());
      const page = await context.newPage();
      try {
        const data = await Promise.race([
          scrapeTaskPage(page, fullUrl, context, taskIdFromUrl),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${taskTimeoutMs/1000}s`)), taskTimeoutMs)),
        ]);
        data.managebac_url  = fullUrl;
        data.class_name     = cls.name;
        data.class_id       = cls.class_id;
        if (!data.name || data.name.length < 2) data.name = listName || 'Untitled';
        if (listTags?.length) data.tags = [...new Set([...(listTags || []), ...(data.tags || [])])];
        data.submissionStatus  = submissionStatus || null;
        data.assessmentStatus  = assessmentStatus || null;
        data.criterionGrades   = criterionGrades || {};
        freshTasks.push(data);
        console.log(`[scraper]   ✔ ${data.name}`);
      } catch (err) {
        console.warn(`[scraper]   ⚠ Skipping task (${err.message}): ${fullUrl}`);
      } finally {
        await page.close().catch(() => {});
      }
      if (taskDelay > 0) await new Promise(r => setTimeout(r, taskDelay));
    }
  }

  const workerCount = Math.min(taskConcurrency, uniqueLinks.length || 1);
  await Promise.all(Array.from({ length: workerCount }, taskWorker));
  return freshTasks;
}

async function scrapeTasks(options = {}) {
  const authPath = fsi.authPath();
  if (!fs.existsSync(authPath)) throw new Error('No auth session — run POST /login first');

  const classes = classesLib.listClasses().filter(c => {
    if (!c.enabled) return false;
    if (options.className) return c.name.toLowerCase().includes(options.className.toLowerCase());
    return true;
  });

  if (classes.length === 0) throw new Error('No enabled classes — run POST /login then POST /setup first');

  const { concurrency, taskDelay } = SPEED_PRESETS[options.speed || 'medium'];
  const taskTimeoutMs = (options.taskTimeoutSeconds || 60) * 1000;

  console.log(`[scraper] Scraping ${classes.length} class(es)...`);

  const browser = await chromium.launch({ headless: true });
  const ctx = { ref: await browser.newContext({ storageState: authPath }) };

  let totalTasks = 0;
  try {
    for (const cls of classes) {
      try {
        const freshTasks = await scrapeClass(ctx.ref, cls, taskDelay, taskTimeoutMs, concurrency);
        for (const rawTask of freshTasks) {
          const existing = tasksLib.listTasks(cls.class_id)
            .find(t => t.managebac_url === rawTask.managebac_url);

          const taskId = existing ? existing.id : tasksLib.nextTaskId(cls.class_id);
          const task = {
            id:               taskId,
            managebac_url:    rawTask.managebac_url,
            name:             rawTask.name || 'Untitled',
            class_name:       cls.name,
            class_id:         cls.class_id,
            due_date:         rawTask.due_date || null,
            submissionStatus: rawTask.submissionStatus ?? existing?.submissionStatus ?? null,
            assessmentStatus: rawTask.assessmentStatus ?? existing?.assessmentStatus ?? null,
            criterionGrades:  rawTask.criterionGrades || {},
            tags:             rawTask.tags || [],
            description:      rawTask.description || '',
            description_html: rawTask.description_html || '',
            attachments:      rawTask.attachments || [],
            teacher_comment:  rawTask.teacher_comment || null,
            scraped_at:       new Date().toISOString(),
          };
          if (existing) {
            task.notion_page_id = existing.notion_page_id || null;
          }
          tasksLib.saveTask(cls.class_id, task);
          totalTasks++;
        }
      } catch (err) {
        console.error(`[scraper] Error scraping ${cls.name}: ${err.message}`);
      }
    }
  } finally {
    await ctx.ref.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const status = { ok: true, totalTasks, classes: classes.length, scraped_at: new Date().toISOString() };
  fsi.writeJson(fsi.statusPath(), status);
  console.log(`[scraper] Done. ${totalTasks} tasks saved.`);
  return status;
}

async function scrapeOneTask(url) {
  const authPath = fsi.authPath();
  if (!fs.existsSync(authPath)) throw new Error('No auth session — run POST /login first');

  const taskIdFromUrl = (url.match(/\/core_tasks\/(\d+)/) || [])[1] || String(Date.now());
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authPath });
  const page    = await context.newPage();

  try {
    const data = await scrapeTaskPage(page, url, context, taskIdFromUrl);
    data.managebac_url = url;
    data.scraped_at = new Date().toISOString();

    // Find existing task by URL and update
    const allTasks = tasksLib.listTasks();
    const existing = allTasks.find(t => t.managebac_url === url);
    if (existing) {
      const updated = { ...existing, ...data, id: existing.id };
      tasksLib.saveTask(existing.class_id, updated);
      return updated;
    }

    // New task — need class info from URL; save to first enabled class or unknown
    data.id = `mb_${taskIdFromUrl}`;
    const classes = classesLib.listClasses().filter(c => c.enabled);
    const targetClass = classes[0];
    if (targetClass) {
      data.class_id = targetClass.class_id;
      data.class_name = targetClass.name;
      tasksLib.saveTask(targetClass.class_id, data);
    }
    return data;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeTasks, scrapeOneTask };
