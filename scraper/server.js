require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express    = require('express');
const fsi        = require('./lib/fs');
const { login }  = require('./login');
const { discoverClasses } = require('./discover');
const { scrapeTasks, scrapeOneTask } = require('./scraper');
const classesLib = require('./lib/classes');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ── Ensure data dir exists ──────────────────────────────────────────────────
fsi.ensureDir(fsi.dataDir());
fsi.ensureDir(fsi.classesDir());

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const status = fsi.readJson(fsi.statusPath());
  res.json({ ok: true, lastScrape: status?.scraped_at || null });
});

// ── First-run: login + discover classes ────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const email    = req.body.email    || process.env.MB_EMAIL;
    const password = req.body.password || process.env.MB_PASSWORD;

    if (!email || !password) {
      return res.status(400).json({
        error: 'MISSING_CREDENTIALS',
        message: 'Provide email and password in body or set MB_EMAIL / MB_PASSWORD in .env',
      });
    }

    await login(email, password);
    const { classes, conflicts } = await discoverClasses();

    // Auto-persist classes, auto-skipping older conflict duplicates
    const skipIds = new Set(
      conflicts.flatMap(group => group.filter(c => c.suggested === 'skip').map(c => c.classId))
    );

    for (const c of classes) {
      if (skipIds.has(c.classId)) continue;
      const existing = classesLib.listClasses().find(x => x.managebac_class_id === c.classId);
      if (!existing) {
        classesLib.createClass({
          name: c.name,
          managebac_class_id: c.classId,
          enabled: true,
        });
      }
    }

    res.json({
      ok: true,
      classes: classes.length,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      message: conflicts.length > 0
        ? 'Conflicts detected — call POST /setup with enabledClassIds to resolve'
        : 'All classes enabled. Run POST /scrape to start scraping.',
    });
  } catch (err) {
    console.error('[scraper] login error:', err.message);
    res.status(500).json({ error: 'SCRAPER_LOGIN_FAILED', message: err.message });
  }
});

// ── Setup: resolve class conflicts / override enabled list ─────────────────
app.post('/setup', (req, res) => {
  try {
    const { enabledClassIds } = req.body;
    if (!Array.isArray(enabledClassIds)) {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'enabledClassIds must be an array of ManageBac class IDs' });
    }

    const enabledSet = new Set(enabledClassIds.map(String));
    const classes = classesLib.listClasses();

    for (const cls of classes) {
      const shouldEnable = enabledSet.has(String(cls.managebac_class_id));
      classesLib.updateClass(cls.class_id, { enabled: shouldEnable });
    }

    fsi.writeJson(fsi.configPath(), {
      enabledClassIds: [...enabledSet],
      configured_at: new Date().toISOString(),
    });

    res.json({
      ok: true,
      enabled: classes.filter(c => enabledSet.has(String(c.managebac_class_id))).map(c => c.name),
      disabled: classes.filter(c => !enabledSet.has(String(c.managebac_class_id))).map(c => c.name),
    });
  } catch (err) {
    res.status(500).json({ error: 'SETUP_FAILED', message: err.message });
  }
});

// ── List classes ───────────────────────────────────────────────────────────
app.get('/classes', (req, res) => {
  try {
    const classes = classesLib.listClasses().map(c => ({
      class_id: c.class_id,
      managebac_class_id: c.managebac_class_id,
      name: c.name,
      enabled: c.enabled,
    }));
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: 'CLASSES_READ_FAILED', message: err.message });
  }
});

// ── Full scrape ────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  try {
    const { speed } = req.body || {};
    const result = await scrapeTasks({ speed: speed || 'medium' });
    res.json(result);
  } catch (err) {
    console.error('[scraper] scrape error:', err.message);
    res.status(500).json({ error: 'SCRAPE_FAILED', message: err.message });
  }
});

// ── Targeted single-task scrape ────────────────────────────────────────────
app.post('/scrape/task', async (req, res) => {
  try {
    const { url, class: className, task: taskName } = req.body || {};

    let targetUrl = url;

    if (!targetUrl && (className || taskName)) {
      const { listTasks } = require('./lib/tasks');
      const allTasks = listTasks();
      const match = allTasks.find(t => {
        const classMatch = !className || t.class_name?.toLowerCase().includes(className.toLowerCase());
        const taskMatch  = !taskName  || t.name?.toLowerCase().includes(taskName.toLowerCase());
        return classMatch && taskMatch;
      });
      if (!match) {
        return res.status(404).json({
          error: 'TASK_NOT_FOUND',
          message: `No cached task found matching class="${className}" task="${taskName}". Run a full scrape first.`,
        });
      }
      targetUrl = match.managebac_url;
    }

    if (!targetUrl) {
      return res.status(400).json({
        error: 'MISSING_TARGET',
        message: 'Provide url, or class+task in the request body',
      });
    }

    const result = await scrapeOneTask(targetUrl);
    res.json({ ok: true, task: result });
  } catch (err) {
    console.error('[scraper] scrape/task error:', err.message);
    res.status(500).json({ error: 'SCRAPE_TASK_FAILED', message: err.message });
  }
});

// ── Status ─────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const status = fsi.readJson(fsi.statusPath()) || { ok: false, message: 'No scrape run yet' };
  res.json(status);
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`[scraper] running on port ${PORT}`));
