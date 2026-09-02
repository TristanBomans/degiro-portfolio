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
const END = '2026-09-02';

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdays(from, to) {
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d);
  }
  return dates;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function series(dates, start, end, wobble = 0.04) {
  return dates.map((date, i) => {
    const t = dates.length === 1 ? 1 : i / (dates.length - 1);
    const wave = Math.sin(i / 18) * wobble + Math.sin(i / 7) * (wobble / 2);
    return Math.round((lerp(start, end, t) * (1 + wave)) * 100) / 100;
  });
}

const portfolioDates = weekdays('2023-01-16', END);
const vwceDates = weekdays('2024-07-01', END);
const asmlDates = weekdays('2025-03-03', END);

const portfolioValues = series(portfolioDates, 18200, 41280, 0.035);
const portfolioInvested = series(portfolioDates, 17500, 33840, 0.008);
const portfolioOpen = series(portfolioDates, 16800, 32410, 0.01);

const vwceValues = series(vwceDates, 6120, 9480, 0.03);
const vwceCosts = vwceDates.map((_, i) => (i < 80 ? 6120 : i < 210 ? 7840 : 8610));
const asmlValues = series(asmlDates, 4280, 5960, 0.05);
const asmlCosts = asmlDates.map(() => 4410);

const holdings = [
  {
    id: 1,
    is_manual: false,
    symbol: 'VWCE',
    name: 'Vanguard FTSE All-World UCITS ETF',
    isin: 'IE00BK5BQT80',
    currency: 'EUR',
    shares: 72,
    latest_price: 131.67,
    price_change_pct: 0.42,
    price_date: END,
    ytd_change_eur: 612.4,
    ytd_change_pct: 6.91,
    exchange: 'XETRA',
    yahoo_ticker: 'VWCE.DE',
  },
  {
    id: 2,
    is_manual: false,
    symbol: 'IWDA',
    name: 'iShares Core MSCI World UCITS ETF',
    isin: 'IE00B4L5Y983',
    currency: 'EUR',
    shares: 95,
    latest_price: 108.14,
    price_change_pct: 0.18,
    price_date: END,
    ytd_change_eur: 488.2,
    ytd_change_pct: 4.99,
    exchange: 'AMS',
    yahoo_ticker: 'IWDA.AS',
  },
  {
    id: 3,
    is_manual: false,
    symbol: 'ASML',
    name: 'ASML Holding',
    isin: 'NL0010273215',
    currency: 'EUR',
    shares: 6,
    latest_price: 993.4,
    price_change_pct: -0.86,
    price_date: END,
    ytd_change_eur: 214.8,
    ytd_change_pct: 3.74,
    exchange: 'AMS',
    yahoo_ticker: 'ASML.AS',
  },
  {
    id: 11,
    is_manual: true,
    symbol: 'NVO',
    name: 'Novo Nordisk',
    isin: 'DK0062498333',
    currency: 'EUR',
    shares: 18,
    latest_price: 71.2,
    price_change_pct: 1.12,
    price_date: END,
    exchange: 'Trade Republic',
    yahoo_ticker: 'NVO',
    broker: 'Trade Republic',
    cost_basis_eur: 1494,
    total_value_eur: 1281.6,
  },
];

const performance = {
  holdings: [
    {
      id: 1,
      key: 's-1',
      is_manual: false,
      kind: 'tracker',
      name: 'Vanguard FTSE All-World UCITS ETF',
      symbol: 'VWCE',
      yahoo_ticker: 'VWCE.DE',
      exchange: 'XETRA',
      currency: 'EUR',
      shares: 72,
      cost_eur: 8610,
      value_eur: 9480.24,
      gain_eur: 870.24,
      gain_pct: 10.11,
      first_purchase_date: '2024-07-01',
      lots: [
        {
          id: 's-1-101',
          date: '2024-07-01',
          remaining_qty: 48,
          original_qty: 48,
          buy_price: 127.5,
          currency: 'EUR',
          cost_eur: 6120,
          value_eur: 6320.16,
          gain_eur: 200.16,
          gain_pct: 3.27,
        },
        {
          id: 's-1-102',
          date: '2025-02-12',
          remaining_qty: 24,
          original_qty: 24,
          buy_price: 103.75,
          currency: 'EUR',
          cost_eur: 2490,
          value_eur: 3160.08,
          gain_eur: 670.08,
          gain_pct: 26.91,
        },
      ],
    },
    {
      id: 2,
      key: 's-2',
      is_manual: false,
      kind: 'tracker',
      name: 'iShares Core MSCI World UCITS ETF',
      symbol: 'IWDA',
      yahoo_ticker: 'IWDA.AS',
      exchange: 'AMS',
      currency: 'EUR',
      shares: 95,
      cost_eur: 8920,
      value_eur: 10273.3,
      gain_eur: 1353.3,
      gain_pct: 15.17,
      first_purchase_date: '2023-01-16',
      lots: [
        {
          id: 's-2-201',
          date: '2023-01-16',
          remaining_qty: 95,
          original_qty: 95,
          buy_price: 93.89,
          currency: 'EUR',
          cost_eur: 8920,
          value_eur: 10273.3,
          gain_eur: 1353.3,
          gain_pct: 15.17,
        },
      ],
    },
    {
      id: 3,
      key: 's-3',
      is_manual: false,
      kind: 'stock',
      name: 'ASML Holding',
      symbol: 'ASML',
      yahoo_ticker: 'ASML.AS',
      exchange: 'AMS',
      currency: 'EUR',
      shares: 6,
      cost_eur: 4410,
      value_eur: 5960.4,
      gain_eur: 1550.4,
      gain_pct: 35.16,
      first_purchase_date: '2025-03-03',
      lots: [
        {
          id: 's-3-301',
          date: '2025-03-03',
          remaining_qty: 6,
          original_qty: 6,
          buy_price: 735,
          currency: 'EUR',
          cost_eur: 4410,
          value_eur: 5960.4,
          gain_eur: 1550.4,
          gain_pct: 35.16,
        },
      ],
    },
    {
      id: 11,
      key: 'm-11',
      is_manual: true,
      kind: 'manual',
      name: 'Novo Nordisk',
      symbol: 'NVO',
      yahoo_ticker: 'NVO',
      exchange: 'Trade Republic',
      currency: 'EUR',
      shares: 18,
      cost_eur: 1494,
      value_eur: 1281.6,
      gain_eur: -212.4,
      gain_pct: -14.22,
      first_purchase_date: '2025-11-04',
      lots: [
        {
          id: 'm-11-1',
          date: '2025-11-04',
          remaining_qty: 18,
          original_qty: 18,
          buy_price: 83,
          currency: 'EUR',
          cost_eur: 1494,
          value_eur: 1281.6,
          gain_eur: -212.4,
          gain_pct: -14.22,
        },
      ],
    },
  ],
};

const snapshotHoldings = [
  { id: 1, is_manual: false, name: 'Vanguard FTSE All-World UCITS ETF', symbol: 'VWCE', exchange: 'XETRA', currency: 'EUR', shares: 72, price: 131.67, total_value_eur: 9480.24, daily_change_eur: 39.6, daily_change_pct: 0.42, ytd_change_eur: 612.4, ytd_change_pct: 6.91 },
  { id: 2, is_manual: false, name: 'iShares Core MSCI World UCITS ETF', symbol: 'IWDA', exchange: 'AMS', currency: 'EUR', shares: 95, price: 108.14, total_value_eur: 10273.3, daily_change_eur: 18.24, daily_change_pct: 0.18, ytd_change_eur: 488.2, ytd_change_pct: 4.99 },
  { id: 3, is_manual: false, name: 'ASML Holding', symbol: 'ASML', exchange: 'AMS', currency: 'EUR', shares: 6, price: 993.4, total_value_eur: 5960.4, daily_change_eur: -51.6, daily_change_pct: -0.86, ytd_change_eur: 214.8, ytd_change_pct: 3.74 },
  { id: 11, is_manual: true, name: 'Novo Nordisk', symbol: 'NVO', exchange: 'Trade Republic', currency: 'EUR', shares: 18, price: 71.2, total_value_eur: 1281.6, daily_change_eur: 14.22, daily_change_pct: 1.12, ytd_change_eur: -186, ytd_change_pct: -12.68 },
];

const scanFills = [
  {
    id: 'msg-1:ORD-88421',
    product: 'VANGUARD FTSEAW UCITS ETF',
    isin: 'IE00BK5BQT80',
    date: '2026-08-28',
    time: '14:22:11',
    quantity: 8,
    totalEur: 1049.36,
    duplicate: false,
  },
  {
    id: 'msg-2:ORD-88304',
    product: 'ISHS CORE MSCI WORLD ETF',
    isin: 'IE00B4L5Y983',
    date: '2026-08-22',
    time: '09:41:03',
    quantity: 6,
    totalEur: 647.1,
    duplicate: false,
  },
  {
    id: 'msg-3:ORD-87112',
    product: 'ASML HOLDING',
    isin: 'NL0010273215',
    date: '2026-07-15',
    time: '11:08:44',
    quantity: 1,
    totalEur: 918.2,
    duplicate: true,
  },
];

function json(res, body, status = 200) {
  res.status(status).json(body);
}

function startMockServer() {
  const app = express();
  app.use(express.json());
  app.use('/static', express.static(STATIC));
  app.get('/', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
  app.get('/manifest.json', (_req, res) => res.sendFile(path.join(ROOT, 'src', 'static', 'manifest.json')));

  app.get('/api/ping', (_req, res) => json(res, { status: 'ok', server: 'DEGIRO Portfolio', version: '0.5.13' }));
  app.get('/api/config', (_req, res) => json(res, { include_other_brokers_default: true }));
  app.get('/api/user-preferences', (_req, res) => json(res, {
    success: true,
    summary_cards: { current_value: true, net_invested: true, deposits: true, current_profit_loss: true, total_profit_loss: true },
  }));
  app.get('/api/exchange-rates', (_req, res) => json(res, { success: true, rates: { EUR: 1, USD: 0.86, GBP: 1.17, SEK: 0.09 } }));
  app.get('/api/holdings', (_req, res) => json(res, { holdings }));
  app.get('/api/portfolio-summary', (_req, res) => json(res, {
    total_holdings: 4,
    net_invested: 33840,
    open_cost: 32410,
    current_value: 41280.54,
    gain_loss: 7440.54,
    gain_loss_percent: 21.99,
    open_gain_loss: 8870.54,
    open_gain_loss_percent: 27.37,
    total_deposited: 36000,
    total_withdrawals: 0,
    net_deposited: 36000,
    total_profit_loss: 5280.54,
    total_profit_loss_percent: 14.67,
    other_brokers_included: true,
    other_brokers_value: 1281.6,
    other_brokers_invested: 1494,
    other_brokers_count: 1,
  }));
  app.get('/api/portfolio-valuation-history', (_req, res) => json(res, {
    dates: portfolioDates,
    values: portfolioValues,
    invested: portfolioInvested,
    open_cost: portfolioOpen,
  }));
  app.get('/api/performance', (_req, res) => json(res, performance));
  app.get('/api/time-travel/range', (_req, res) => json(res, { min_date: '2023-01-16', max_date: END }));
  app.get('/api/time-travel', (req, res) => json(res, {
    date: req.query.date || END,
    total_value_eur: 41280.54,
    daily_change_eur: 20.46,
    daily_change_pct: 0.05,
    holdings: snapshotHoldings,
  }));
  app.get('/api/manual-holdings', (_req, res) => json(res, {
    holdings: [{
      id: 11,
      name: 'Novo Nordisk',
      symbol: 'NVO',
      shares: 18,
      cost_basis_eur: 1494,
      total_value_eur: 1281.6,
      gain_loss_eur: -212.4,
      gain_loss_percent: -14.22,
      price_change_pct: 1.12,
      broker: 'Trade Republic',
    }],
  }));
  app.get('/api/stock/:id/position-chart', (req, res) => {
    if (req.params.id === '3') return json(res, { dates: asmlDates, values: asmlValues, costs: asmlCosts });
    return json(res, { dates: vwceDates, values: vwceValues, costs: vwceCosts });
  });
  app.get('/api/manual-holdings/:id/position-chart', (_req, res) => json(res, {
    dates: weekdays('2025-11-04', END),
    values: series(weekdays('2025-11-04', END), 1494, 1281.6, 0.04),
    costs: weekdays('2025-11-04', END).map(() => 1494),
  }));
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
    fills: scanFills,
    newCount: 2,
    duplicateCount: 1,
    emailsFound: 3,
    emailsFailed: 0,
    parseErrors: [],
  }));
  app.post('/api/refresh-live-prices', (_req, res) => json(res, { success: true, count: 4 }));
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
  await page.screenshot({ path: file, fullPage: true });
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

async function capture(page, prefix) {
  await waitReady(page);
  await shot(page, `${prefix}-overview`);

  await openView(page, 'graph');
  await sleep(400);
  await shot(page, `${prefix}-graph`);

  await openView(page, 'performance');
  await page.locator('[data-perf-select="s-1"]').click();
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
