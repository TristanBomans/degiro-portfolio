import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const STATIC = path.join(ROOT, 'src', 'static');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-fixture.json'), 'utf8'));

function json(res, body, status = 200) {
  res.status(status).json(body);
}

function startMockServer() {
  const app = express();
  app.use(express.json());
  app.use('/static', express.static(STATIC));
  app.get('/', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
  app.get('/manifest.json', (_req, res) => res.sendFile(path.join(STATIC, 'manifest.json')));

  app.get('/api/ping', (_req, res) => json(res, { status: 'ok', server: 'DEGIRO Portfolio', version: '0.5.13' }));
  app.get('/api/config', (_req, res) => json(res, { include_other_brokers_default: true }));
  app.get('/api/user-preferences', (_req, res) => json(res, {
    success: true,
    summary_cards: { current_value: true, net_invested: true, deposits: true, current_profit_loss: true, total_profit_loss: true },
  }));
  app.get('/api/exchange-rates', (_req, res) => json(res, fixture.rates));
  app.get('/api/holdings', (_req, res) => json(res, fixture.holdings));
  app.get('/api/portfolio-summary', (_req, res) => json(res, fixture.summary));
  app.get('/api/portfolio-valuation-history', (_req, res) => json(res, fixture.history));
  app.get('/api/performance', (_req, res) => json(res, fixture.performance));
  app.get('/api/time-travel/range', (_req, res) => json(res, fixture.range));
  app.get('/api/time-travel', (req, res) => json(res, {
    ...fixture.snapshot,
    date: req.query.date || fixture.snapshot.date,
  }));
  app.get('/api/manual-holdings', (_req, res) => json(res, fixture.manuals));
  app.get('/api/stock/:id/position-chart', (req, res) => {
    json(res, fixture.positionCharts[`s-${req.params.id}`] || { dates: [], values: [], costs: [] });
  });
  app.get('/api/manual-holdings/:id/position-chart', (req, res) => {
    json(res, fixture.positionCharts[`m-${req.params.id}`] || { dates: [], values: [], costs: [] });
  });
  app.get('/api/gmail/status', (_req, res) => json(res, {
    success: true,
    connected: true,
    email: 'alex@example.com',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    lastScan: '2026-09-01T18:22:11.000Z',
  }));
  app.post('/api/gmail/scan', (_req, res) => json(res, {
    success: true,
    token: 'demo-token',
    message: 'Found 2 new fills · 1 already in the portfolio',
    fills: fixture.scanFills,
    newCount: fixture.scanFills.filter((fill) => !fill.duplicate).length,
    duplicateCount: fixture.scanFills.filter((fill) => fill.duplicate).length,
    emailsFound: 3,
    emailsFailed: 0,
    parseErrors: [],
  }));
  app.post('/api/refresh-live-prices', (_req, res) => json(res, {
    success: true,
    count: fixture.holdings.holdings.length,
  }));
  app.use('/api', (_req, res) => json(res, { success: true }));

  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading');
    const overview = document.getElementById('overview-content');
    return loading && loading.style.display === 'none' && overview && overview.style.display === 'block';
  }, { timeout: 15000 });
  await sleep(250);
}

async function openView(page, name) {
  if (await page.locator('#menu-btn').isVisible()) {
    await page.locator('#menu-btn').click();
    await sleep(200);
  }
  await page.locator(`.nav-item[data-view="${name}"]`).click();
  await sleep(350);
}

async function openScan(page) {
  if (await page.locator('#menu-btn').isVisible()) {
    await page.locator('#menu-btn').click();
    await sleep(200);
  }
  await page.locator('#sidebar-scan-btn').click();
  await page.waitForSelector('#scan-overlay.show .dialog-scan', { timeout: 15000 });
  await sleep(200);
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

async function capture(page, prefix) {
  await waitReady(page);
  await shot(page, `${prefix}-overview`);

  await openView(page, 'graph');
  await page.locator('#chart-range-selector [data-range="MAX"]').click();
  await sleep(400);
  await shot(page, `${prefix}-graph`);

  await openView(page, 'performance');
  await page.locator(`[data-perf-select="${fixture.featuredKey}"]`).click();
  await page.waitForSelector('#lot-chart-block:not([hidden])');
  await sleep(500);
  await shot(page, `${prefix}-performance`);

  await openView(page, 'history');
  await sleep(250);
  await shot(page, `${prefix}-history`);

  await openView(page, 'brokers');
  await sleep(250);
  await shot(page, `${prefix}-brokers`);

  await openScan(page);
  await shot(page, `${prefix}-mailbox-scan`);
  await page.keyboard.press('Escape');
  await sleep(150);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, url } = await startMockServer();
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
  try {
    const desktop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
    });
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
    });

    for (const [context, prefix] of [[desktop, 'desktop'], [mobile, 'mobile']]) {
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem('degiro-theme', 'dark');
        localStorage.setItem('includeOtherBrokers', 'true');
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      await capture(page, prefix);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
