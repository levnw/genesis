'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const fsi = require('./lib/fs');
const classesLib = require('./lib/classes');
const { MB_BASE_URL } = require('./login');

function normalizeSubject(name) {
  return name
    .replace(/\bphases?\s*[\d,\s\/]+/gi, '')
    .replace(/\bgrade\s*\d+/gi, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\b[A-Z][A-Z0-9]{0,3}\b/g, '')
    .replace(/[^a-zA-Z\s]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function detectConflicts(discovered) {
  const groups = new Map();
  for (const cls of discovered) {
    const key = normalizeSubject(cls.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cls);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

const extractScript = () => {
  const ACTION_WORDS = /^(view|go to|open|core tasks|tasks|assignments|click|see all|more|details|overview)\b/i;

  function bestName(a) {
    const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');
    if (linkText.length > 2 && linkText.length < 150 && !ACTION_WORDS.test(linkText)) return linkText;
    const container = a.closest(
      'li, tr, .class-item, .group-item, .card, [class*="class-card"],' +
      '[class*="group-card"], [class*="subject"], [class*="course"]'
    ) || a.parentElement;
    if (container) {
      const heading = container.querySelector(
        'h1,h2,h3,h4,h5,strong,.title,.name,[class*="title"],[class*="name"],[class*="subject"],[class*="course-name"]'
      );
      if (heading) {
        const h = heading.textContent.trim().replace(/\s+/g, ' ');
        if (h.length > 2 && h.length < 150 && !ACTION_WORDS.test(h)) return h;
      }
    }
    return null;
  }

  const seen = new Map();
  document.querySelectorAll('a[href]').forEach(a => {
    const m = (a.getAttribute('href') || '').match(/\/student\/classes\/(\d+)/);
    if (!m) return;
    const classId = m[1];
    if (seen.has(classId) && seen.get(classId) !== `Class ${classId}`) return;
    seen.set(classId, bestName(a) || `Class ${classId}`);
  });
  return Array.from(seen.entries()).map(([classId, name]) => ({ classId, name }));
};

async function discoverClasses() {
  const authPath = fsi.authPath();
  if (!fs.existsSync(authPath)) throw new Error('No auth session — run POST /login first');

  console.log('[scraper] Discovering classes...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authPath });
  const page    = await context.newPage();

  try {
    await page.goto(`${MB_BASE_URL}/student/classes`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

    if (/\/(login|sign_in)(\/|$|\?)/.test(page.url())) {
      throw new Error('Session expired — run POST /login again');
    }

    let discovered = await page.evaluate(extractScript);

    if (discovered.length === 0) {
      await page.goto(`${MB_BASE_URL}/student`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      discovered = await page.evaluate(extractScript);
    }

    for (const fallback of ['/student/ib', '/student/classes?all=1']) {
      if (discovered.length > 0) break;
      await page.goto(`${MB_BASE_URL}${fallback}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      discovered = await page.evaluate(extractScript);
    }

    if (discovered.length === 0) throw new Error('No classes found on ManageBac');

    // Deduplicate by exact name — keep highest (newest) classId
    const sorted = [...discovered].sort((a, b) => parseInt(b.classId) - parseInt(a.classId));
    const byName = new Map();
    for (const c of sorted) {
      if (!byName.has(c.name)) byName.set(c.name, c);
    }
    const unique = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

    // Detect conflicts — return them to the caller for user resolution
    const conflicts = detectConflicts(unique).map(group =>
      group
        .sort((a, b) => parseInt(b.classId) - parseInt(a.classId))
        .map((c, i) => ({ ...c, suggested: i === 0 ? 'keep' : 'skip' }))
    );

    return { classes: unique, conflicts };
  } finally {
    await browser.close();
  }
}

module.exports = { discoverClasses };
