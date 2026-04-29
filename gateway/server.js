require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Auth middleware — all routes except /health require x-api-key
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid x-api-key header' });
  }
  next();
});

// Health — pings all services
app.get('/health', async (req, res) => {
  const services = ['scraper', 'notion', 'ai'];
  const urls = {
    scraper: process.env.SCRAPER_URL,
    notion: process.env.NOTION_URL,
    ai: process.env.AI_URL,
  };

  const statuses = await Promise.all(
    services.map(async (name) => {
      try {
        const r = await fetch(`${urls[name]}/health`, { timeout: 3000 });
        return { name, ok: r.ok };
      } catch {
        return { name, ok: false };
      }
    })
  );

  const all = statuses.every((s) => s.ok);
  res.status(all ? 200 : 207).json({ ok: all, services: statuses });
});

// Proxy routes
// Note: Express strips the mount prefix from req.url before handing to middleware,
// so /notion/tasks arrives at the proxy as /tasks — no pathRewrite needed.
const proxyOpts = (target) => ({
  target,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      res.status(502).json({
        error: 'GATEWAY_PROXY_ERROR',
        message: `Could not reach upstream service`,
        details: err.message,
      });
    },
  },
});

const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3001';
const NOTION_URL  = process.env.NOTION_URL  || 'http://localhost:3002';
const AI_URL      = process.env.AI_URL      || 'http://localhost:3003';

app.use('/scrape', createProxyMiddleware(proxyOpts(SCRAPER_URL)));
app.use('/notion', createProxyMiddleware(proxyOpts(NOTION_URL)));
app.use('/ai',     createProxyMiddleware(proxyOpts(AI_URL)));

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`[gateway] running on port ${PORT}`));
