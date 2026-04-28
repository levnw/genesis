'use strict';

const { chromium } = require('playwright');
const fsi = require('./lib/fs');

const MB_BASE_URL = 'https://app.managebac.com';

async function login(email, password) {
  if (!email || !password) throw new Error('MB_EMAIL and MB_PASSWORD are required');

  console.log(`[scraper] Logging in to ManageBac as ${email}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();

  try {
    await page.goto(`${MB_BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.fill('input[type="email"], input[name="email"], input[id="user_email"]', email);
    await page.fill('input[type="password"], input[name="password"], input[id="user_password"]', password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);

    if (/\/(login|sign_in)(\/|$|\?)/.test(page.url())) {
      throw new Error('Login failed — still on login page. Check credentials.');
    }

    fsi.ensureDir(fsi.dataDir());
    await context.storageState({ path: fsi.authPath() });
    console.log('[scraper] Logged in. Session saved.');
    return { ok: true };
  } finally {
    await browser.close();
  }
}

module.exports = { login, MB_BASE_URL };
