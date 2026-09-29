(() => {
  const VIEW_META = {
    overview: { title: 'Overview', subtitle: 'Live value, invested capital, and P/L' },
    graph: { title: 'Graph', subtitle: 'Portfolio value and holdings on a selected date' },
    performance: { title: 'Performance', subtitle: 'Return per tracker and per purchase' },
    tax: { title: 'Capital gains tax', subtitle: 'Realised result, exemption and what-if sales' },
    history: { title: 'History', subtitle: 'Month-end value and gain / loss' },
    brokers: { title: 'Other brokers', subtitle: 'Manual holdings outside DEGIRO' },
  };

  const TRACKER_KEYWORDS = ['ETF', 'UCITS', 'Tracker', 'iShares', 'Vanguard', 'SPDR', 'Amundi', 'Xtrackers', 'Lyxor'];
  const VIEW_ORDER = ['overview', 'graph', 'performance', 'tax', 'history', 'brokers'];

  const state = {
    holdings: [],
    includeOtherBrokers: true,
    selectedChartRange: 'YTD',
    chartAutoScale: true,
    summaryCardVisibility: {
      current_value: true,
      net_invested: true,
      deposits: true,
      current_profit_loss: true,
      total_profit_loss: true,
    },
    performanceHoldings: [],
    perfCollapsed: {},
    perfGroupCollapsed: { closed: true },
    selectedLotId: null,
    selectedHoldingKey: null,
    selectedPerfRange: 'MAX',
    perfDetailExpanded: false,
    perfOverlayOpen: false,
    perfOverlayHistoryEntry: false,
    perfOverlayTrigger: null,
    lotChartData: null,
    serverConfig: null,
    latestPortfolioSummary: null,
    latestPortfolioHistoryData: null,
    portfolioHistoryDates: [],
    selectedHistoryDate: null,
    chartRangeOffset: 0,
    exchangeRates: { EUR: 1, USD: null, SEK: null, GBP: null },
    uploadInProgress: false,
    livePricesInterval: null,
    hasData: false,
    serverWasOffline: false,
    holdingChangeMode: localStorage.getItem('holdingChangeMode') === 'eur' ? 'eur' : 'pct',
    capitalGains: null,
    taxYear: new Date().getFullYear(),
    taxSims: [],
    taxSimMode: 'shares',
    taxSimKey: null,
    taxDraftQty: 0,
    taxFreeQty: 0,
    taxPlanEnter: -1,
  };

  const $ = (id) => document.getElementById(id);

  // Last successful responses are kept locally so the app opens on the last
  // known numbers instantly and refreshes them once the server answers.
  const CACHE_PREFIX = 'pm-cache:';

  function readCache(url) {
    try {
      return JSON.parse(localStorage.getItem(CACHE_PREFIX + url));
    } catch {
      return null;
    }
  }

  function writeCache(url, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + url, JSON.stringify(data));
    } catch { /* storage full or unavailable */ }
  }

  function clearCache() {
    Object.keys(localStorage).filter((key) => key.startsWith(CACHE_PREFIX)).forEach((key) => localStorage.removeItem(key));
  }

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const data = await resp.json();
    if (resp.ok) writeCache(url, data);
    return data;
  }

  function otherBrokersQueryParam() {
    return `?includeOtherBrokers=${state.includeOtherBrokers ? '1' : '0'}`;
  }

  function formatEur(value) {
    return `€${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatSignedEur(value) {
    const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${prefix}${formatEur(value)}`;
  }

  // Whole euros carry the figure; cents sit smaller and lighter behind them.
  function formatEurHtml(value) {
    const text = formatEur(value);
    const dot = text.lastIndexOf('.');
    return dot < 0 ? text : `${text.slice(0, dot)}<span class="cents">${text.slice(dot)}</span>`;
  }

  // Large amounts in narrow spots read as €11.9k; the exact amount stays in the title.
  function formatShortSignedEur(value) {
    const amount = Math.abs(value);
    if (amount < 10000) return formatSignedEur(value);
    const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
    const [divisor, suffix] = amount >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
    return `${prefix}€${(amount / divisor).toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`;
  }

  function formatCompactEur(value) {
    const amount = Math.round(Math.abs(Number(value) || 0) * 100) / 100;
    const minimumFractionDigits = Number.isInteger(amount) ? 0 : 2;
    return `€${amount.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits: 2 })}`;
  }

  function formatPct(value) {
    const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${prefix}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }

  // One primary figure with its change, then quieter secondary metrics whose
  // delta follows the shared %/€ preference (tap them to switch).
  function summaryHtml({ label, value, change, secondary = [], note = '', animate = false }) {
    const numAttrs = (key, amount, format) => (animate
      ? ` data-num="${key}" data-value="${amount}" data-format="${format}"`
      : '');
    const changeHtml = change?.eur != null
      ? `<div class="summary-change ${numberClass(change.eur)}">
          <span${numAttrs('change', change.eur, 'signedEur')}>${formatSignedEur(change.eur)}</span>
          ${change.pct != null ? `<span class="summary-change-pct">${formatPct(change.pct)}</span>` : ''}
          ${change.horizon ? `<span class="summary-horizon">${escapeHtml(change.horizon)}</span>` : ''}
        </div>`
      : '';
    const items = summarySecondaryHtml(secondary);
    return `
      <div class="summary">
        <div class="summary-main">
          <div class="summary-label">${label}</div>
          <div class="summary-value"${numAttrs('value', value, 'eurHtml')}>${formatEurHtml(value)}</div>
          ${changeHtml}
        </div>
        ${items}
        ${note ? `<div class="summary-note">${escapeHtml(note)}</div>` : ''}
      </div>`;
  }

  // Invested / Open with their delta; tapping switches the shared %/€ mode.
  function summarySecondaryHtml(secondary, extraClass = '') {
    if (!secondary.length) return '';
    const showEur = state.holdingChangeMode === 'eur';
    const narrow = isCompactView();
    const items = secondary.map((item) => {
      const delta = showEur ? item.eur : item.pct;
      const deltaText = delta == null ? '' : (showEur ? (narrow ? formatShortSignedEur(delta) : formatSignedEur(delta)) : formatPct(delta));
      const deltaTitle = showEur && delta != null ? ` title="${formatSignedEur(delta)}"` : '';
      return `
        <span class="summary-item">
          <span class="summary-item-label"><i class="legend-swatch ${item.kind}"></i>${item.label}</span>
          <span class="summary-item-figures">
            <span class="summary-item-value">${item.value != null ? formatEurHtml(item.value) : '—'}</span>
            <span class="summary-item-delta ${numberClass(delta)}"${deltaTitle}>${deltaText}</span>
          </span>
        </span>`;
    }).join('');
    return `<button class="summary-secondary ${extraClass}" type="button" data-toggle-change-mode title="Show gains in ${showEur ? 'percent' : 'euro'}">${items}</button>`;
  }

  const shownNumbers = new Map();

  // Numbers that changed since the last render roll to their new value.
  function formatNetHtml(value) {
    return `${value < 0 ? '-' : ''}${formatEurHtml(value)}`;
  }

  function animateNumbers(root, { instant = false } = {}) {
    const reduce = instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelectorAll('[data-num]').forEach((el) => {
      const key = el.dataset.num;
      const to = Number(el.dataset.value);
      const from = shownNumbers.get(key);
      shownNumbers.set(key, to);
      el.dataset.tween = String((Number(el.dataset.tween) || 0) + 1);
      if (reduce || from == null || !Number.isFinite(to) || Math.abs(from - to) < 0.005) return;
      const format = { signedEur: formatSignedEur, eurHtml: formatEurHtml, netHtml: formatNetHtml }[el.dataset.format] || formatEur;
      const tween = el.dataset.tween;
      const paint = (amount) => {
        if (/Html$/.test(el.dataset.format || '')) el.innerHTML = format(amount);
        else el.textContent = format(amount);
      };
      const start = performance.now();
      const duration = 650;
      const step = (now) => {
        if (!el.isConnected || el.dataset.tween !== tween) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 3;
        paint(from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(step);
      };
      paint(from);
      requestAnimationFrame(step);
    });
  }

  function setChangeMode(mode) {
    if (mode === state.holdingChangeMode) return;
    state.holdingChangeMode = mode;
    localStorage.setItem('holdingChangeMode', mode);
    renderHoldingChangeMode();
    renderHoldings();
    if (state.latestPortfolioSummary) renderSummary(state.latestPortfolioSummary);
    renderGraphHeader();
    renderTimeTravel();
  }

  function holdingsDayChange() {
    let current = 0;
    let previous = 0;
    let hasChange = false;
    for (const stock of state.holdings) {
      const rate = state.exchangeRates[stock.currency] || 1;
      if (stock.latest_price == null || stock.shares == null) continue;
      const value = stock.shares * stock.latest_price * rate;
      current += value;
      if (stock.price_change_pct != null) {
        previous += value / (1 + stock.price_change_pct / 100);
        hasChange = true;
      } else {
        previous += value;
      }
    }
    if (!hasChange || previous <= 0) return null;
    const eur = current - previous;
    return { eur, pct: (eur / previous) * 100 };
  }

  function latestPriceMoment() {
    let latest = null;
    for (const stock of state.holdings) {
      const raw = String(stock.price_date || '');
      if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) continue;
      const moment = { day: raw.slice(0, 10), ms: raw.includes('T') ? Date.parse(raw) : null };
      if (!latest || moment.day > latest.day || (moment.day === latest.day && (moment.ms || 0) > (latest.ms || 0))) {
        latest = moment;
      }
    }
    return latest;
  }

  // Price days are UTC market days. When the latest prices are from an
  // earlier session (weekend, before the open) name that day instead of "1d".
  function dayChangeHorizon(latest = latestPriceMoment()) {
    if (!latest || latest.day === new Date().toISOString().slice(0, 10)) return '1d';
    return new Date(`${latest.day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  }

  function priceFreshnessLabel(latest = latestPriceMoment()) {
    if (!latest) return '';
    if (latest.ms == null) return `Prices ${formatDay(latest.day)}`;
    const at = new Date(latest.ms);
    const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sameDay = at.toDateString() === new Date().toDateString();
    const ageDays = (Date.now() - latest.ms) / 86400000;
    if (sameDay) return `Prices ${time}`;
    if (ageDays < 6) return `Prices ${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
    return `Prices ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
  }

  function holdingDayChangeEur(stock, valueEur) {
    if (valueEur == null || stock.price_change_pct == null) return null;
    return valueEur - valueEur / (1 + stock.price_change_pct / 100);
  }

  function formatShares(n) {
    if (n == null) return '—';
    if (Number.isInteger(n)) return String(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  function formatShareCount(n) {
    const quantity = Number(n);
    return `${formatShares(n)} ${Math.abs(quantity - 1) < 1e-8 ? 'share' : 'shares'}`;
  }

  function formatDay(date) {
    if (!date) return '—';
    return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function parseDayMs(date) {
    return new Date(`${date}T00:00:00`).getTime();
  }

  function xOfTime(date, dates, padLeft, plotW) {
    if (!dates?.length) return padLeft;
    const t0 = parseDayMs(dates[0]);
    const t1 = parseDayMs(dates[dates.length - 1]);
    if (t1 === t0) return padLeft;
    return padLeft + ((parseDayMs(date) - t0) / (t1 - t0)) * plotW;
  }

  function indexFromTimeX(x, dates, padLeft, plotW) {
    if (!dates?.length) return null;
    const t0 = parseDayMs(dates[0]);
    const t1 = parseDayMs(dates[dates.length - 1]);
    const span = t1 - t0 || 1;
    const u = Math.min(1, Math.max(0, (x - padLeft) / Math.max(1, plotW)));
    const target = t0 + u * span;
    let lo = 0;
    let hi = dates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (parseDayMs(dates[mid]) < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(parseDayMs(dates[lo - 1]) - target) <= Math.abs(parseDayMs(dates[lo]) - target)) {
      return lo - 1;
    }
    return lo;
  }

  function axisTickDates(dates) {
    if (!dates?.length) return [];
    if (dates.length <= 4) return dates;
    const t0 = parseDayMs(dates[0]);
    const t1 = parseDayMs(dates[dates.length - 1]);
    const mid = new Date(t0 + (t1 - t0) / 2);
    const midDate = `${mid.getFullYear()}-${String(mid.getMonth() + 1).padStart(2, '0')}-${String(mid.getDate()).padStart(2, '0')}`;
    return [dates[0], midDate, dates[dates.length - 1]];
  }

  function formatAxisDate(date) {
    return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  }

  function formatAxisEur(value, step) {
    const sign = value < 0 ? '-' : '';
    const amount = Math.abs(value);
    const absStep = Math.abs(step) || 1;
    if (amount >= 1000) {
      const fractionDigits = absStep >= 1000 ? 0 : absStep >= 100 ? 1 : 2;
      const compact = (amount / 1000).toLocaleString('en-US', {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
      return `${sign}€${compact}k`;
    }
    const fractionDigits = absStep >= 1 ? 0 : 2;
    return `${sign}€${amount.toLocaleString('en-US', {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })}`;
  }

  function numberClass(value) {
    if (value > 0) return 'positive';
    if (value < 0) return 'negative';
    return '';
  }

  function getCurrencySymbol(currency) {
    return ({ USD: '$', EUR: '€', GBP: '£', JPY: '¥', SEK: 'SEK', NOK: 'NOK', DKK: 'DKK', CHF: 'CHF', CAD: 'C$', AUD: 'A$' })[currency] || currency;
  }

  function formatPrice(price, currency) {
    if (price == null) return '—';
    const symbol = getCurrencySymbol(currency);
    const n = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return ['$', '€', '£', '¥', 'C$', 'A$'].includes(symbol) ? `${symbol}${n}` : `${n} ${symbol}`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function showToast(message, isSuccess) {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast show ${isSuccess ? 'success' : 'error'}`;
    setTimeout(() => el.classList.remove('show'), 4500);
  }

  function showProgress(message, progress) {
    $('progress-message').textContent = message;
    $('progress-fill').style.width = `${progress}%`;
    $('progress-toast').classList.add('show');
  }

  function hideProgress() {
    $('progress-toast').classList.remove('show');
  }

  function setLoading(text, visible) {
    const row = $('loading');
    if (text) $('loading-status').textContent = text;
    row.style.display = visible ? '' : 'none';
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function chartColors() {
    const dark = document.documentElement.classList.contains('dark');
    return {
      value: cssVar('--primary') || '#4f46e5',
      invested: cssVar('--success') || '#10b981',
      open: cssVar('--warning') || '#f59e0b',
      grid: cssVar('--border') || (dark ? 'rgba(255,255,255,0.08)' : '#e4e4e7'),
      text: cssVar('--muted-foreground') || '#71717a',
      fill: dark ? 'rgba(99, 102, 241, 0.16)' : 'rgba(79, 70, 229, 0.10)',
      fillTop: dark ? 'rgba(99, 102, 241, 0.30)' : 'rgba(79, 70, 229, 0.18)',
      fillBottom: dark ? 'rgba(99, 102, 241, 0)' : 'rgba(79, 70, 229, 0)',
    };
  }

  // Monotone cubic (Fritsch–Carlson) through the points: smooth, but never
  // overshoots a local high or low. Dense series are already smooth enough.
  function traceSmoothLine(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length < 3 || pts.length > 400) {
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      return;
    }
    const n = pts.length;
    const slopes = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x || 1e-6;
      slopes.push((pts[i + 1].y - pts[i].y) / dx);
    }
    const tangents = [slopes[0]];
    for (let i = 1; i < n - 1; i++) {
      tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
    }
    tangents.push(slopes[n - 2]);
    for (let i = 0; i < n - 1; i++) {
      if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
      const a = tangents[i] / slopes[i];
      const b = tangents[i + 1] / slopes[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        tangents[i] = t * a * slopes[i];
        tangents[i + 1] = t * b * slopes[i];
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const dx = (pts[i + 1].x - pts[i].x) / 3;
      ctx.bezierCurveTo(
        pts[i].x + dx, pts[i].y + tangents[i] * dx,
        pts[i + 1].x - dx, pts[i + 1].y - tangents[i + 1] * dx,
        pts[i + 1].x, pts[i + 1].y,
      );
    }
  }

  function fillArea(ctx, pts, baseY, top, colors) {
    if (!pts.length) return;
    ctx.beginPath();
    traceSmoothLine(ctx, pts);
    ctx.lineTo(pts[pts.length - 1].x, baseY);
    ctx.lineTo(pts[0].x, baseY);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, top, 0, baseY);
    gradient.addColorStop(0, colors.fillTop);
    gradient.addColorStop(1, colors.fillBottom);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  // When the visible range changes the axis eases to its new scale while the
  // series is revealed from left to right.
  const REVEAL_MS = 520;

  function startChartReveal(chart) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    chart.reveal = { start: performance.now(), fromRange: chart.lastRange || null };
    requestAnimationFrame(() => chart.draw());
  }

  function chartRevealState(chart, targetRange) {
    const reveal = chart.reveal;
    if (!reveal) return { progress: 1, range: targetRange };
    const t = Math.min(1, (performance.now() - reveal.start) / REVEAL_MS);
    const eased = 1 - (1 - t) ** 3;
    if (t >= 1) chart.reveal = null;
    else requestAnimationFrame(() => chart.draw());
    const from = reveal.fromRange;
    const range = from
      ? { min: from.min + (targetRange.min - from.min) * eased, max: from.max + (targetRange.max - from.max) * eased }
      : targetRange;
    return { progress: eased, range };
  }

  const valuationChart = {
    canvas: null,
    ctx: null,
    wrap: null,
    tooltip: null,
    hoverIndex: null,
    scrubbing: false,
    reveal: null,
    lastRange: null,
    bound: false,

    placeLiveDot(point) {
      const dot = $('chart-live-dot');
      if (!dot) return;
      dot.hidden = !point;
      if (point) dot.style.transform = `translate(${point.x}px, ${point.y}px)`;
    },

    pad: { top: 12, right: 12, bottom: 26, left: 52 },

    init() {
      this.canvas = $('valuation-canvas');
      this.wrap = $('chart-canvas-wrap');
      this.tooltip = $('chart-tooltip');
      if (!this.canvas || !this.wrap) return;
      this.ctx = this.canvas.getContext('2d');
      if (this.bound) return;
      this.bound = true;

      // Touch scrubs the selection (the header above shows the values), while a
      // mouse keeps the hover tooltip and selects on click or drag.
      const selectAt = (e) => {
        const idx = this.indexFromEvent(e);
        const date = idx != null ? this.visibleSlice()?.dates[idx] : null;
        if (date) selectGraphDate(date);
      };
      this.canvas.addEventListener('pointerdown', (e) => {
        this.scrubbing = true;
        this.canvas.setPointerCapture?.(e.pointerId);
        if (e.pointerType !== 'mouse') this.tooltip.hidden = true;
        selectAt(e);
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (this.scrubbing) selectAt(e);
        if (e.pointerType === 'mouse') this.onPointer(e);
      });
      const endScrub = (e) => {
        if (!this.scrubbing) return;
        this.scrubbing = false;
        if (e.pointerType !== 'mouse') {
          this.hoverIndex = null;
          this.draw();
        }
        scheduleGraphSnapshot(true);
      };
      this.canvas.addEventListener('pointerup', endScrub);
      this.canvas.addEventListener('pointercancel', endScrub);
      this.canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'mouse') return;
        this.hoverIndex = null;
        this.tooltip.hidden = true;
        this.draw();
      });
      new ResizeObserver(() => this.draw()).observe(this.wrap);
    },

    visibleSlice() {
      const data = state.latestPortfolioHistoryData;
      if (!data?.dates?.length) return null;
      const { startIdx, endIdx } = graphWindow();
      return {
        dates: data.dates.slice(startIdx, endIdx + 1),
        values: data.values.slice(startIdx, endIdx + 1),
        invested: data.invested.slice(startIdx, endIdx + 1),
        openCost: (data.open_cost || []).slice(startIdx, endIdx + 1),
      };
    },

    yRange(slice) {
      const nums = [];
      for (let i = 0; i < slice.values.length; i++) {
        if (slice.values[i] != null) nums.push(slice.values[i]);
        if (slice.invested[i] != null) nums.push(slice.invested[i]);
        if (slice.openCost[i] != null) nums.push(slice.openCost[i]);
      }
      if (!nums.length) return { min: 0, max: 1 };
      const dataMin = Math.min(...nums);
      const dataMax = Math.max(...nums);
      if (state.chartAutoScale) {
        const span = dataMax - dataMin || Math.abs(dataMax) || 1;
        return { min: dataMin - span * 0.08, max: dataMax + span * 0.08 };
      }
      return { min: 0, max: dataMax > 0 ? dataMax * 1.08 : 1 };
    },

    layout() {
      const dpr = window.devicePixelRatio || 1;
      const width = this.wrap.clientWidth || 640;
      const height = this.wrap.clientHeight || 360;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.pad = window.matchMedia('(max-width: 860px)').matches
        ? { top: 8, right: 8, bottom: 22, left: 44 }
        : { top: 12, right: 12, bottom: 26, left: 52 };
      const { pad } = this;
      return {
        width, height,
        plotW: Math.max(1, width - pad.left - pad.right),
        plotH: Math.max(1, height - pad.top - pad.bottom),
      };
    },

    xOf(i, dates, plotW) {
      return xOfTime(dates[i], dates, this.pad.left, plotW);
    },

    yOf(v, range, plotH) {
      const t = (v - range.min) / (range.max - range.min || 1);
      return this.pad.top + plotH - t * plotH;
    },

    niceTicks(min, max, count = 4) {
      const span = max - min || 1;
      const raw = span / count;
      const mag = 10 ** Math.floor(Math.log10(raw));
      const norm = raw / mag;
      const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
      const start = Math.ceil(min / step) * step;
      const ticks = [];
      for (let v = start; v <= max + step * 0.01; v += step) ticks.push(v);
      return ticks;
    },

    indexFromEvent(e) {
      const slice = this.visibleSlice();
      if (!slice?.dates.length) return null;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { pad } = this;
      const plotW = Math.max(1, rect.width - pad.left - pad.right);
      return indexFromTimeX(x, slice.dates, pad.left, plotW);
    },

    onPointer(e) {
      const idx = this.indexFromEvent(e);
      if (idx == null) return;
      this.hoverIndex = idx;
      this.draw();
      this.showTooltip(idx, e);
    },

    showTooltip(idx, e) {
      const slice = this.visibleSlice();
      if (!slice) return;
      const date = slice.dates[idx];
      const value = slice.values[idx] ?? 0;
      const invested = slice.invested[idx] ?? 0;
      const openCost = slice.openCost[idx] ?? 0;
      const pretty = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      this.tooltip.innerHTML = `
        <div class="chart-tooltip-date">${pretty}</div>
        <div class="chart-tooltip-row">
          <i class="legend-swatch value"></i>
          <span>Portfolio value</span>
          <strong>${formatEur(value)}</strong>
        </div>
        <div class="chart-tooltip-row">
          <i class="legend-swatch invested"></i>
          <span>Net invested</span>
          <strong>${formatEur(invested)}</strong>
        </div>
        <div class="chart-tooltip-row">
          <i class="legend-swatch open"></i>
          <span>Open positions</span>
          <strong>${formatEur(openCost)}</strong>
        </div>
      `;
      this.tooltip.hidden = false;
      const wrapRect = this.wrap.getBoundingClientRect();
      const x = e.clientX - wrapRect.left;
      const y = e.clientY - wrapRect.top;
      const tipW = this.tooltip.offsetWidth;
      const tipH = this.tooltip.offsetHeight;
      const left = Math.min(wrapRect.width - tipW - 8, Math.max(8, x + 14));
      const top = Math.min(wrapRect.height - tipH - 8, Math.max(8, y - tipH - 12));
      this.tooltip.style.left = `${left}px`;
      this.tooltip.style.top = `${top}px`;
    },

    draw() {
      if (!this.ctx) this.init();
      if (!this.ctx) return;
      const slice = this.visibleSlice();
      const { width, height, plotW, plotH } = this.layout();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, width, height);
      if (!slice?.dates.length) return;

      const targetRange = this.yRange(slice);
      const { progress, range } = chartRevealState(this, targetRange);
      this.lastRange = targetRange;
      const colors = chartColors();
      const n = slice.dates.length;
      const { pad } = this;

      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.text;
      ctx.font = `${window.matchMedia('(max-width: 860px)').matches ? 10 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const yTicks = this.niceTicks(range.min, range.max);
      const yTickStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : (range.max - range.min) / 4;
      for (const tick of yTicks) {
        const y = this.yOf(tick, range, plotH);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        ctx.fillText(formatAxisEur(tick, yTickStep), pad.left - 8, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = axisTickDates(slice.dates);
      const seen = new Set();
      for (const date of xTicks) {
        const label = formatAxisDate(date);
        if (seen.has(label) && date !== xTicks[0] && date !== xTicks[xTicks.length - 1]) continue;
        seen.add(label);
        const isLast = date === xTicks[xTicks.length - 1] && xTicks.length > 1;
        ctx.textAlign = isLast ? 'right' : 'center';
        ctx.fillText(label, isLast ? pad.left + plotW : xOfTime(date, slice.dates, pad.left, plotW), pad.top + plotH + 8);
      }

      const pathFor = (series) => {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          if (series[i] == null) continue;
          const x = this.xOf(i, slice.dates, plotW);
          const y = this.yOf(series[i], range, plotH);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
      };

      const valuePts = [];
      for (let i = 0; i < n; i++) {
        if (slice.values[i] == null) continue;
        valuePts.push({ x: this.xOf(i, slice.dates, plotW), y: this.yOf(slice.values[i], range, plotH) });
      }

      ctx.save();
      if (progress < 1) {
        ctx.beginPath();
        ctx.rect(0, 0, pad.left + plotW * progress + 3, height);
        ctx.clip();
        ctx.globalAlpha = 0.35 + 0.65 * progress;
      }
      fillArea(ctx, valuePts, this.yOf(Math.max(0, range.min), range, plotH), pad.top, colors);

      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = colors.invested;
      ctx.lineWidth = 1.6;
      pathFor(slice.invested);
      ctx.stroke();

      ctx.setLineDash([1.5, 3.5]);
      ctx.strokeStyle = colors.open;
      ctx.lineWidth = 1.6;
      pathFor(slice.openCost);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = colors.value;
      ctx.lineWidth = 2.1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      traceSmoothLine(ctx, valuePts);
      ctx.stroke();
      ctx.restore();
      this.placeLiveDot(progress === 1 && state.chartRangeOffset === 0 ? valuePts[valuePts.length - 1] : null);

      const markDate = state.selectedHistoryDate;
      if (markDate) {
        const mi = slice.dates.indexOf(markDate);
        if (mi >= 0) {
          const x = this.xOf(mi, slice.dates, plotW);
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = colors.value;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, pad.top);
          ctx.lineTo(x, pad.top + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
          if (slice.values[mi] != null && this.hoverIndex !== mi) {
            ctx.beginPath();
            ctx.fillStyle = colors.value;
            ctx.arc(x, this.yOf(slice.values[mi], range, plotH), 3.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = cssVar('--card') || '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }

      if (this.hoverIndex != null && slice.dates[this.hoverIndex]) {
        const i = this.hoverIndex;
        const x = this.xOf(i, slice.dates, plotW);
        ctx.strokeStyle = colors.text;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const drawDot = (series, color) => {
          if (series[i] == null) return;
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(x, this.yOf(series[i], range, plotH), 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = cssVar('--card') || '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        };
        drawDot(slice.values, colors.value);
        drawDot(slice.invested, colors.invested);
        drawDot(slice.openCost, colors.open);
      }
    },
  };

  const lotChart = {
    canvas: null,
    ctx: null,
    wrap: null,
    tooltip: null,
    hoverIndex: null,
    reveal: null,
    lastRange: null,
    bound: false,
    pad: { top: 12, right: 12, bottom: 26, left: 52 },

    init() {
      this.canvas = $('lot-canvas');
      this.wrap = $('lot-chart-wrap');
      this.tooltip = $('lot-tooltip');
      if (!this.canvas || !this.wrap) return;
      this.ctx = this.canvas.getContext('2d');
      if (this.bound) return;
      this.bound = true;
      this.canvas.addEventListener('pointermove', (e) => this.onPointer(e));
      this.canvas.addEventListener('pointerleave', () => {
        this.hoverIndex = null;
        this.tooltip.hidden = true;
        this.draw();
      });
      new ResizeObserver(() => this.draw()).observe(this.wrap);
    },

    layout() {
      const dpr = window.devicePixelRatio || 1;
      const width = this.wrap.clientWidth || 480;
      const height = this.wrap.clientHeight || 280;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.pad = window.matchMedia('(max-width: 860px)').matches
        ? { top: 8, right: 8, bottom: 22, left: 44 }
        : { top: 12, right: 12, bottom: 26, left: 52 };
      const { pad } = this;
      return {
        width, height,
        plotW: Math.max(1, width - pad.left - pad.right),
        plotH: Math.max(1, height - pad.top - pad.bottom),
      };
    },

    xOf(i, dates, plotW) {
      return xOfTime(dates[i], dates, this.pad.left, plotW);
    },

    yOf(v, range, plotH) {
      const t = (v - range.min) / (range.max - range.min || 1);
      return this.pad.top + plotH - t * plotH;
    },

    niceTicks(min, max, count = 4) {
      const span = max - min || 1;
      const raw = span / count;
      const mag = 10 ** Math.floor(Math.log10(raw));
      const norm = raw / mag;
      const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
      const start = Math.ceil(min / step) * step;
      const ticks = [];
      for (let v = start; v <= max + step * 0.01; v += step) ticks.push(v);
      return ticks;
    },

    visibleSlice() {
      const data = state.lotChartData;
      if (!data?.dates?.length) return null;
      const [start, end] = getChartRangeBounds(state.selectedPerfRange, data.dates);
      let startIdx = data.dates.findIndex((d) => d >= start);
      let endIdx = data.dates.length - 1;
      for (let i = data.dates.length - 1; i >= 0; i--) {
        if (data.dates[i] <= end) { endIdx = i; break; }
      }
      if (startIdx === -1) startIdx = 0;
      if (endIdx < startIdx) endIdx = startIdx;
      return {
        dates: data.dates.slice(startIdx, endIdx + 1),
        values: data.values.slice(startIdx, endIdx + 1),
        costs: data.costs ? data.costs.slice(startIdx, endIdx + 1) : null,
        cost: data.cost ?? null,
        mode: data.mode || 'lot',
      };
    },

    yRange() {
      const slice = this.visibleSlice();
      if (!slice?.values?.length) return { min: 0, max: 1 };
      const nums = slice.values.filter((v) => v != null);
      if (slice.costs) nums.push(...slice.costs.filter((v) => v != null));
      if (slice.cost != null) nums.push(slice.cost);
      if (!nums.length) return { min: 0, max: 1 };
      const dataMin = Math.min(...nums);
      const dataMax = Math.max(...nums);
      const span = dataMax - dataMin || Math.abs(dataMax) || 1;
      return { min: dataMin - span * 0.08, max: dataMax + span * 0.08 };
    },

    indexFromEvent(e) {
      const slice = this.visibleSlice();
      if (!slice?.dates?.length) return null;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { pad } = this;
      const plotW = Math.max(1, rect.width - pad.left - pad.right);
      return indexFromTimeX(x, slice.dates, pad.left, plotW);
    },

    onPointer(e) {
      const idx = this.indexFromEvent(e);
      if (idx == null) return;
      this.hoverIndex = idx;
      this.draw();
      this.showTooltip(idx, e);
    },

    showTooltip(idx, e) {
      const slice = this.visibleSlice();
      if (!slice) return;
      const date = slice.dates[idx];
      const value = slice.values[idx] ?? 0;
      const cost = slice.costs ? slice.costs[idx] : slice.cost;
      const pretty = formatDay(date);
      const valueLabel = slice.mode === 'position' ? 'Position value' : 'Lot value';
      const gain = cost != null ? value - cost : null;
      const gainPct = cost > 0 && gain != null ? (gain / cost) * 100 : null;
      this.tooltip.innerHTML = `
        <div class="chart-tooltip-date">${pretty}</div>
        <div class="chart-tooltip-row">
          <i class="legend-swatch value"></i>
          <span>${valueLabel}</span>
          <strong>${formatEur(value)}</strong>
        </div>
        ${cost != null ? `<div class="chart-tooltip-row">
          <i class="legend-swatch invested"></i>
          <span>Cost</span>
          <strong>${formatEur(cost)}</strong>
        </div>` : ''}
        ${gain != null ? `<div class="chart-tooltip-row">
          <span>Gain / loss</span>
          <strong class="${numberClass(gain)}">${formatSignedEur(gain)}${gainPct != null ? ` (${formatPct(gainPct)})` : ''}</strong>
        </div>` : ''}
      `;
      this.tooltip.hidden = false;
      const wrapRect = this.wrap.getBoundingClientRect();
      const x = e.clientX - wrapRect.left;
      const y = e.clientY - wrapRect.top;
      const tipW = this.tooltip.offsetWidth;
      const tipH = this.tooltip.offsetHeight;
      this.tooltip.style.left = `${Math.min(wrapRect.width - tipW - 8, Math.max(8, x + 14))}px`;
      this.tooltip.style.top = `${Math.min(wrapRect.height - tipH - 8, Math.max(8, y - tipH - 12))}px`;
    },

    draw() {
      if (!this.ctx) this.init();
      if (!this.ctx) return;
      const slice = this.visibleSlice();
      const { width, height, plotW, plotH } = this.layout();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, width, height);
      if (!slice?.dates?.length) return;

      const targetRange = this.yRange();
      const { progress, range } = chartRevealState(this, targetRange);
      this.lastRange = targetRange;
      const colors = chartColors();
      const n = slice.dates.length;
      const { pad } = this;

      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.text;
      ctx.font = `${window.matchMedia('(max-width: 860px)').matches ? 10 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const yTicks = this.niceTicks(range.min, range.max);
      const yTickStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : (range.max - range.min) / 4;
      for (const tick of yTicks) {
        const y = this.yOf(tick, range, plotH);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        ctx.fillText(formatAxisEur(tick, yTickStep), pad.left - 8, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = axisTickDates(slice.dates);
      const seen = new Set();
      for (const date of xTicks) {
        const label = formatAxisDate(date);
        if (seen.has(label) && date !== xTicks[0] && date !== xTicks[xTicks.length - 1]) continue;
        seen.add(label);
        const isLast = date === xTicks[xTicks.length - 1] && xTicks.length > 1;
        ctx.textAlign = isLast ? 'right' : 'center';
        ctx.fillText(label, isLast ? pad.left + plotW : xOfTime(date, slice.dates, pad.left, plotW), pad.top + plotH + 8);
      }

      const pathFor = (series) => {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          if (series[i] == null) continue;
          const x = this.xOf(i, slice.dates, plotW);
          const y = this.yOf(series[i], range, plotH);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
      };

      ctx.save();
      if (progress < 1) {
        ctx.beginPath();
        ctx.rect(0, 0, pad.left + plotW * progress + 3, height);
        ctx.clip();
        ctx.globalAlpha = 0.35 + 0.65 * progress;
      }

      if (slice.costs) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = colors.invested;
        ctx.lineWidth = 1.6;
        pathFor(slice.costs);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (slice.cost != null) {
        const y = this.yOf(slice.cost, range, plotH);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = colors.invested;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const valuePts = [];
      for (let i = 0; i < n; i++) {
        if (slice.values[i] == null) continue;
        valuePts.push({ x: this.xOf(i, slice.dates, plotW), y: this.yOf(slice.values[i], range, plotH) });
      }
      // The area represents the value series; always close it at the bottom of
      // the plot. A cost baseline can put fill above earlier value points.
      fillArea(ctx, valuePts, pad.top + plotH, pad.top, colors);

      ctx.strokeStyle = colors.value;
      ctx.lineWidth = 2.1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      traceSmoothLine(ctx, valuePts);
      ctx.stroke();
      ctx.restore();

      if (this.hoverIndex != null && slice.dates[this.hoverIndex]) {
        const i = this.hoverIndex;
        const x = this.xOf(i, slice.dates, plotW);
        ctx.strokeStyle = colors.text;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const dot = (series, color) => {
          if (!series || series[i] == null) return;
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(x, this.yOf(series[i], range, plotH), 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = cssVar('--card') || '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        };
        dot(slice.values, colors.value);
        if (slice.costs) dot(slice.costs, colors.invested);
      }
    },
  };

  // The theme follows the device unless Settings pins light or dark.
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');

  // A new key: the old toggle stored whatever was showing, which was not a choice.
  const THEME_KEY = 'degiro-theme-mode';

  function themeMode() {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  }

  function initTheme() {
    applyTheme(false);
    systemDark?.addEventListener?.('change', () => {
      if (themeMode() === 'system') applyTheme();
    });
  }

  function applyTheme(relayout = true) {
    const mode = themeMode();
    const dark = mode === 'dark' || (mode === 'system' && Boolean(systemDark?.matches));
    document.documentElement.classList.toggle('dark', dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#18181b' : '#ffffff');
    document.querySelectorAll('#theme-mode [data-theme-mode]').forEach((btn) => {
      const active = btn.dataset.themeMode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    syncSegIndicator($('theme-mode'));
    if (relayout) applyThemeToChart();
  }

  function setThemeMode(mode) {
    localStorage.removeItem('degiro-theme');
    if (mode === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
    applyTheme();
  }

  function applyThemeToChart() {
    valuationChart.draw();
    lotChart.draw();
  }

  function setView(name) {
    const current = document.querySelector('.view.active')?.id?.replace(/^view-/, '');
    if (!VIEW_META[name]) return;
    if (current === name) {
      setSidebarOpen(false);
      setMobileMoreOpen(false);
      return;
    }
    if (current === 'performance' && name !== 'performance') {
      setPerfExpanded(false);
    }
    const direction = VIEW_ORDER.indexOf(name) >= VIEW_ORDER.indexOf(current) ? 'forward' : 'back';
    const activateView = () => {
      document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === name);
      });
      document.querySelectorAll('.mobile-tab[data-view]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === name);
      });
      $('mobile-more-btn')?.classList.toggle('active', name === 'brokers');
      document.querySelectorAll('.view').forEach((view) => {
        view.classList.toggle('active', view.id === `view-${name}`);
      });
      const meta = VIEW_META[name];
      $('view-title').textContent = meta.title;
      $('view-subtitle').textContent = meta.subtitle;
    };

    const mobileMotion = window.matchMedia('(max-width: 860px)').matches
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    activateView();
    const activeView = $(`view-${name}`);
    if (mobileMotion) {
      const enterClass = direction === 'forward' ? 'view-enter-forward' : 'view-enter-back';
      activeView.classList.add(enterClass);
      activeView.addEventListener('animationend', () => activeView.classList.remove(enterClass), { once: true });
    }
    setSidebarOpen(false);
    setMobileMoreOpen(false);
    if (name === 'graph') {
      requestAnimationFrame(() => valuationChart.draw());
    }
    if (name === 'performance') {
      requestAnimationFrame(() => lotChart.draw());
    }
    requestAnimationFrame(updateCompactHeader);
  }

  // Once the big value scrolls under the top bar, the bar takes over a compact
  // copy of it (value and change), like iOS large titles collapsing.
  const compactHeaders = {};

  function setCompactHeader(view, value, change) {
    compactHeaders[view] = { value, change };
    updateCompactHeader();
  }

  function updateCompactHeader() {
    const topbar = document.querySelector('.topbar');
    const view = document.querySelector('.view.active');
    const name = view?.id?.replace(/^view-/, '');
    const info = compactHeaders[name];
    const valueEl = view?.querySelector('.summary-value');
    const rect = valueEl?.getBoundingClientRect();
    const compact = Boolean(info && rect?.height && rect.bottom < topbar.getBoundingClientRect().bottom);
    if (compact) {
      const whole = `${info.signed && info.value < 0 ? '-' : ''}${formatEur(info.value).replace(/\.\d+$/, '')}`;
      $('topbar-compact').innerHTML = `<span class="topbar-compact-value">${whole}</span>${info.change?.pct != null
        ? `<span class="topbar-compact-change ${numberClass(info.change.eur)}">${formatPct(info.change.pct)}${info.change.horizon ? ` <em>${escapeHtml(info.change.horizon)}</em>` : ''}</span>`
        : ''}`;
    }
    topbar.classList.toggle('is-compact', compact);
  }

  let compactHeaderFrame = 0;
  window.addEventListener('scroll', () => {
    if (compactHeaderFrame) return;
    compactHeaderFrame = requestAnimationFrame(() => {
      compactHeaderFrame = 0;
      updateCompactHeader();
    });
  }, { passive: true });

  function setConnectionStatus(online) {
    const button = $('live-refresh-btn');
    button.classList.toggle('is-offline', !online);
    const label = online ? 'Refresh live prices' : 'Out of sync — reconnecting automatically';
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  async function checkServerStatus() {
    if (state.uploadInProgress) return true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch('/api/ping', { signal: controller.signal });
      clearTimeout(timeout);
      const ok = resp.ok;
      setConnectionStatus(ok);
      if (ok && state.serverWasOffline) {
        window.location.reload();
        return true;
      }
      state.serverWasOffline = !ok;
      return ok;
    } catch {
      setConnectionStatus(false);
      state.serverWasOffline = true;
      return false;
    }
  }

  async function fetchServerConfig() {
    try {
      const resp = await fetch('/api/config');
      state.serverConfig = await resp.json();
    } catch {
      state.serverConfig = { include_other_brokers_default: true };
    }
  }

  function initIncludeOtherBrokers() {
    const saved = localStorage.getItem('includeOtherBrokers');
    if (saved !== null) state.includeOtherBrokers = saved === 'true';
    else if (state.serverConfig) state.includeOtherBrokers = !!state.serverConfig.include_other_brokers_default;
    $('include-other-brokers').checked = state.includeOtherBrokers;
  }

  async function loadUserPreferences() {
    try {
      const resp = await fetch('/api/user-preferences');
      const data = await resp.json();
      if (data?.summary_cards) {
        state.summaryCardVisibility = { ...state.summaryCardVisibility, ...data.summary_cards };
      }
    } catch (err) {
      console.error('Failed to load preferences', err);
    }
  }

  async function saveUserPreferences(updates) {
    state.summaryCardVisibility = { ...state.summaryCardVisibility, ...updates };
    try {
      await fetch('/api/user-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary_cards: state.summaryCardVisibility }),
      });
      await loadPortfolioSummary();
    } catch (err) {
      console.error('Failed to save preferences', err);
    }
  }

  async function fetchExchangeRates() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const data = await fetchJson('/api/exchange-rates', { signal: controller.signal });
      clearTimeout(timeout);
      if (data?.rates) state.exchangeRates = { ...state.exchangeRates, ...data.rates };
    } catch (err) {
      console.error('Failed to load exchange rates', err);
    }
  }

  function renderSummary(summary) {
    if (!summary) return;
    const latestPrice = latestPriceMoment();
    const note = [
      priceFreshnessLabel(latestPrice),
      summary.other_brokers_count > 0 ? `Includes ${summary.other_brokers_count} other-broker positions` : '',
    ].filter(Boolean).join(' · ');
    const dayChange = holdingsDayChange();
    const horizon = dayChangeHorizon(latestPrice);
    const hero = $('overview-hero');
    hero.innerHTML = summaryHtml({
      label: 'Portfolio value',
      value: summary.current_value,
      change: dayChange ? { ...dayChange, horizon: horizon === '1d' ? 'today' : horizon } : null,
      secondary: [
        { kind: 'invested', label: 'Invested', value: summary.net_invested, eur: summary.gain_loss, pct: summary.gain_loss_percent },
        { kind: 'open', label: 'Open', value: summary.open_cost, eur: summary.open_gain_loss, pct: summary.open_gain_loss_percent },
      ],
      note,
      animate: true,
    });
    animateNumbers(hero);
    setCompactHeader('overview', summary.current_value, dayChange ? { ...dayChange, horizon: horizon === '1d' ? 'today' : horizon } : null);
  }

  async function loadPortfolioSummary({ fromCache = false } = {}) {
    try {
      const url = `/api/portfolio-summary${otherBrokersQueryParam()}`;
      const summary = fromCache ? readCache(url) : await fetchJson(url);
      if (!summary) return null;
      state.latestPortfolioSummary = summary;
      renderSummary(summary);
      return summary;
    } catch (err) {
      console.error('Failed to load summary', err);
      await checkServerStatus();
      return null;
    }
  }

  function renderHoldingChangeMode() {
    // Overview and Graph each carry the switch; both follow the one preference.
    document.querySelectorAll('.change-mode').forEach((seg) => {
      seg.querySelectorAll('[data-mode]').forEach((btn) => {
        const active = btn.dataset.mode === state.holdingChangeMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      syncSegIndicator(seg);
    });
  }

  function renderHoldings() {
    const list = $('holdings-list');
    if (!state.holdings.length) {
      list.innerHTML = '<div class="muted-empty">No current holdings.</div>';
      return;
    }

    const rows = state.holdings.map((stock) => {
      const rate = state.exchangeRates[stock.currency] || 1;
      const valueEur = stock.latest_price != null ? stock.shares * stock.latest_price * rate : null;
      return { stock, valueEur };
    }).sort((a, b) => (b.valueEur || 0) - (a.valueEur || 0));
    const totalValue = rows.reduce((sum, row) => sum + (row.valueEur || 0), 0);

    list.innerHTML = `
      <div class="holdings-list">
        <div class="holdings-head">
          <span>Position</span>
          <span style="text-align:right">Price</span>
          <span style="text-align:right">Value</span>
        </div>
        ${rows.map(({ stock, valueEur }) => {
          const ticker = stock.yahoo_ticker || stock.symbol || '';
          const changeEur = holdingDayChangeEur(stock, valueEur);
          const changeText = state.holdingChangeMode === 'eur' && changeEur != null
            ? formatEur(changeEur)
            : `${Math.abs(stock.price_change_pct ?? 0).toFixed(2)}%`;
          const change = stock.price_change_pct != null
            ? `<span class="price-change ${numberClass(stock.price_change_pct)}">${stock.price_change_pct >= 0 ? '▲' : '▼'} ${changeText}</span>`
            : '';
          const weight = totalValue > 0 && valueEur != null ? (valueEur / totalValue) * 100 : 0;
          const key = `${stock.is_manual ? 'm' : 's'}-${stock.id}`;
          return `
            <div class="holding-row is-clickable" data-perf-key="${key}" style="--weight: ${weight.toFixed(2)}%" title="${weight.toFixed(1)}% of portfolio">
              <div class="holding-info with-avatar">
                ${positionAvatar(stock.name)}
                <div class="with-avatar-text">
                  <div class="holding-name" title="${escapeHtml(stock.name)}">${escapeHtml(positionTitle(stock.name))}</div>
                  <div class="holding-meta">${escapeHtml(ticker)}${stock.exchange ? ` · ${escapeHtml(stock.exchange)}` : ''}<span class="holding-meta-extra">${change ? ` · ${change}` : ''} · ${stock.shares} sh</span></div>
                </div>
              </div>
              <div class="holding-price">
                <div class="price-main">${stock.latest_price != null ? formatPrice(stock.latest_price, stock.currency) : '—'}</div>
                ${change}
              </div>
              <div class="holding-value">
                <div class="value-main"${valueEur != null ? ` data-num="holding-${key}" data-value="${valueEur}" data-format="eur"` : ''}>${valueEur != null ? formatEur(valueEur) : '—'}</div>
                <span class="holding-shares">${stock.shares} shares</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    animateNumbers(list);
  }

  async function loadHoldings({ fromCache = false } = {}) {
    try {
      const url = `/api/holdings${otherBrokersQueryParam()}`;
      let data;
      if (fromCache) {
        data = readCache(url);
        const rates = readCache('/api/exchange-rates');
        if (rates?.rates) state.exchangeRates = { ...state.exchangeRates, ...rates.rates };
        if (!data) return;
      } else {
        [, data] = await Promise.all([fetchExchangeRates(), fetchJson(url)]);
      }
      state.holdings = data.holdings || [];
      renderHoldings();
      if (state.latestPortfolioSummary) renderSummary(state.latestPortfolioSummary);
    } catch (err) {
      console.error('Failed to load holdings', err);
      await checkServerStatus();
    }
  }

  function addMonthsToDate(y, m, d, months) {
    const totalMonths = y * 12 + (m - 1) + months;
    const newYear = Math.floor(totalMonths / 12);
    const newMonth = totalMonths % 12;
    const newDay = Math.min(d, new Date(newYear, newMonth + 1, 0).getDate());
    return `${newYear}-${String(newMonth + 1).padStart(2, '0')}-${String(newDay).padStart(2, '0')}`;
  }

  function addDaysToDate(y, m, d, days) {
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  const CHART_RANGES = ['1W', '1M', 'YTD', '1Y', '3Y', '5Y', 'MAX'];
  const ALWAYS_PERF_RANGES = new Set(['1W', '1M', 'YTD', 'MAX']);

  function getChartRangeBounds(rangeKey, dates) {
    if (!dates?.length) return [null, null];
    const lastDate = dates[dates.length - 1];
    const [lastY, lastM, lastD] = lastDate.split('-').map(Number);
    if (rangeKey === 'MAX') return [dates[0], lastDate];
    if (rangeKey === '1W') return [addDaysToDate(lastY, lastM, lastD, -7), lastDate];
    if (rangeKey === '1M') return [addMonthsToDate(lastY, lastM, lastD, -1), lastDate];
    if (rangeKey === 'YTD') return [`${lastY}-01-01`, lastDate];
    const yearOffsets = { '1Y': -1, '3Y': -3, '5Y': -5 };
    if (yearOffsets[rangeKey]) {
      return [`${lastY + yearOffsets[rangeKey]}-${String(lastM).padStart(2, '0')}-${String(lastD).padStart(2, '0')}`, lastDate];
    }
    return [dates[0], lastDate];
  }

  const RANGE_SPANS = { '1W': { days: 7 }, '1M': { months: 1 }, '1Y': { months: 12 }, '3Y': { months: 36 }, '5Y': { months: 60 } };

  function shiftIsoDate(date, { days = 0, months = 0 }) {
    const [y, m, d] = date.split('-').map(Number);
    return months ? addMonthsToDate(y, m, d, months) : addDaysToDate(y, m, d, days);
  }

  // A graph window is the selected range moved back `offset` whole periods
  // (offset <= 0). Rolling ranges tile end to end; YTD steps through calendar years.
  function getChartWindowBounds(rangeKey, dates, offset = 0) {
    if (!dates?.length) return { start: null, end: null, label: rangeKey, shiftable: false };
    const lastDate = dates[dates.length - 1];
    if (rangeKey === 'YTD') {
      const year = Number(lastDate.slice(0, 4)) + offset;
      return {
        start: `${year}-01-01`,
        end: offset === 0 ? lastDate : `${year}-12-31`,
        label: offset === 0 ? 'YTD' : String(year),
        calendar: true,
        shiftable: true,
      };
    }
    const span = RANGE_SPANS[rangeKey];
    if (!span) {
      return { start: dates[0], end: lastDate, label: 'All', zeroBaseline: true, shiftable: false };
    }
    const end = offset === 0
      ? lastDate
      : shiftIsoDate(lastDate, { days: (span.days || 0) * offset, months: (span.months || 0) * offset });
    const start = shiftIsoDate(end, { days: -(span.days || 0), months: -(span.months || 0) });
    return { start, end, label: rangeKey, shiftable: true };
  }

  function availablePerfRanges(dates) {
    if (!dates?.length) return CHART_RANGES.filter((key) => ALWAYS_PERF_RANGES.has(key));
    const first = dates[0];
    return CHART_RANGES.filter((key) => {
      if (ALWAYS_PERF_RANGES.has(key)) return true;
      const [start] = getChartRangeBounds(key, dates);
      return Boolean(start && first < start);
    });
  }

  // Segmented controls draw one indicator that glides to the active button.
  const observedSegs = new WeakSet();

  function syncSegIndicator(seg) {
    if (!seg) return;
    if (!observedSegs.has(seg)) {
      observedSegs.add(seg);
      new ResizeObserver(() => syncSegIndicator(seg)).observe(seg);
    }
    const active = seg.querySelector('button.active');
    if (!active || !active.offsetWidth) return;
    const first = !seg.classList.contains('has-indicator');
    seg.classList.add('has-indicator');
    seg.style.setProperty('--seg-x', `${active.offsetLeft}px`);
    seg.style.setProperty('--seg-w', `${active.offsetWidth}px`);
    if (first) requestAnimationFrame(() => seg.classList.add('is-ready'));
  }

  function renderChartRangeButtons() {
    $('chart-range-selector').innerHTML = CHART_RANGES.map((key) => `
      <button type="button" class="${key === state.selectedChartRange ? 'active' : ''}" data-range="${key}">${key}</button>
    `).join('');
    syncSegIndicator($('chart-range-selector'));
  }

  function renderLotRangeButtons() {
    const ranges = availablePerfRanges(state.lotChartData?.dates);
    if (!ranges.includes(state.selectedPerfRange)) {
      state.selectedPerfRange = ranges.includes('MAX') ? 'MAX' : (ranges.includes('YTD') ? 'YTD' : ranges[0]);
    }
    const el = $('lot-range-selector');
    if (!el) return;
    el.innerHTML = ranges.map((key) => `
      <button type="button" class="${key === state.selectedPerfRange ? 'active' : ''}" data-range="${key}">${key}</button>
    `).join('');
    syncSegIndicator(el);
  }

  function applyChartRange() {
    valuationChart.draw();
  }

  function updateScaleButton() {
    const btn = $('chart-scale-btn');
    const label = state.chartAutoScale ? 'Scale: fit to data (tap to start from zero)' : 'Scale: from zero (tap to fit to data)';
    btn.classList.toggle('is-active', !state.chartAutoScale);
    btn.setAttribute('aria-pressed', String(!state.chartAutoScale));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function formatPortfolioMonth(date) {
    return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function buildPortfolioHistoryRows(data) {
    const monthEnd = new Map();
    data.dates.forEach((date, index) => {
      monthEnd.set(date.slice(0, 7), { date, value: data.values[index] || 0, invested: data.invested[index] || 0 });
    });
    const sorted = Array.from(monthEnd.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const rows = [];
    const yearTotals = new Map();

    // Gain excludes money moved in or out: a month where €1,000 is invested
    // and the value rises by €1,000 gained nothing. Returns use the capital at
    // work (opening value plus new money), the same measure as the graph.
    const periodReturn = (start, end) => {
      const flow = end.invested - start.invested;
      const gain = end.value - start.value - flow;
      const base = start.value + Math.max(0, flow);
      return { gain, pct: base > 0 ? (gain / base) * 100 : 0 };
    };
    for (let i = 0; i < sorted.length; i++) {
      const [monthKey, snapshot] = sorted[i];
      const year = monthKey.slice(0, 4);
      const prev = i > 0 ? sorted[i - 1][1] : { value: 0, invested: 0 };
      const { gain: gainLoss, pct: gainLossPct } = periodReturn(prev, snapshot);
      rows.push({ type: 'month', date: snapshot.date, year, value: snapshot.value, gainLoss, gainLossPct });
      if (!yearTotals.has(year)) yearTotals.set(year, { start: prev });
      yearTotals.get(year).end = snapshot;
    }
    for (const total of yearTotals.values()) Object.assign(total, periodReturn(total.start, total.end));

    const result = [];
    let currentYear = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (currentYear !== row.year) {
        const yt = yearTotals.get(row.year);
        result.push({
          type: 'year',
          year: row.year,
          value: yt.end.value,
          gainLoss: yt.gain,
          gainLossPct: yt.pct,
        });
        currentYear = row.year;
      }
      result.push(row);
    }
    return result;
  }

  function renderPortfolioHistoryTable(data) {
    const container = $('portfolio-history-table');
    const rows = buildPortfolioHistoryRows(data);
    if (!rows.length) {
      container.innerHTML = '<div class="muted-empty">No history yet.</div>';
      return;
    }
    // Four columns on wide screens; on a phone each row folds to two lines
    // (period over value, euro change over percent) so nothing scrolls sideways.
    container.innerHTML = `
      <div class="history-list" role="table" aria-label="Month-close history">
        <div class="history-row history-head" role="row">
          <span role="columnheader">Period</span>
          <span role="columnheader" class="num">Portfolio value</span>
          <span role="columnheader" class="num">Gain / loss</span>
          <span role="columnheader" class="num">Return</span>
        </div>
        ${rows.map((row) => `
          <div class="history-row${row.type === 'year' ? ' history-year-row' : ''}" role="row">
            <span role="cell" class="history-period">${row.type === 'year' ? `${row.year} total` : formatPortfolioMonth(row.date)}</span>
            <span role="cell" class="num history-value">${formatEur(row.value)}</span>
            <span role="cell" class="num history-gain ${numberClass(row.gainLoss)}">${formatSignedEur(row.gainLoss)}</span>
            <span role="cell" class="num history-pct ${numberClass(row.gainLossPct)}">${row.gainLossPct != null ? formatPct(row.gainLossPct) : '—'}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function graphDates() {
    return state.latestPortfolioHistoryData?.dates || [];
  }

  function lastIndexWhere(dates, predicate) {
    for (let i = dates.length - 1; i >= 0; i--) {
      if (predicate(dates[i])) return i;
    }
    return -1;
  }

  function graphWindow() {
    const data = state.latestPortfolioHistoryData;
    const dates = data?.dates || [];
    const bounds = getChartWindowBounds(state.selectedChartRange, dates, state.chartRangeOffset);
    let startIdx = dates.findIndex((d) => d >= bounds.start);
    if (startIdx === -1) startIdx = 0;
    let endIdx = lastIndexWhere(dates, (d) => d <= bounds.end);
    if (endIdx < startIdx) endIdx = startIdx;

    // The period change is measured from the close before the window (YTD
    // starts from the last close of the previous year). Windows that start
    // before the first data point measure from zero, like the overview.
    let baselineIdx = -1;
    if (!bounds.zeroBaseline) {
      baselineIdx = bounds.calendar
        ? lastIndexWhere(dates, (d) => d < bounds.start)
        : lastIndexWhere(dates, (d) => d <= bounds.start);
    }
    const baseline = baselineIdx >= 0
      ? { date: dates[baselineIdx], value: data.values[baselineIdx] || 0, invested: data.invested[baselineIdx] || 0 }
      : { date: dates.length ? shiftIsoDate(dates[0], { days: -1 }) : null, value: 0, invested: 0 };

    return {
      ...bounds,
      startIdx,
      endIdx,
      baseline,
      hasBaseline: baselineIdx >= 0,
      canPrev: bounds.shiftable && dates.length > 0 && bounds.start > dates[0],
      canNext: bounds.shiftable && state.chartRangeOffset < 0,
    };
  }

  function graphPeriodChange(idx, win = graphWindow()) {
    const data = state.latestPortfolioHistoryData;
    if (!data || idx == null || idx < 0) return null;
    const value = data.values[idx] ?? 0;
    const invested = data.invested[idx] ?? 0;
    const flow = invested - win.baseline.invested;
    const eur = value - win.baseline.value - flow;
    const base = win.baseline.value + Math.max(0, flow);
    return { eur, pct: base > 0 ? (eur / base) * 100 : null };
  }

  function nearestHistoryDate(targetDate, dates = graphDates()) {
    if (!dates.length || !targetDate) return targetDate;
    if (dates.includes(targetDate)) return targetDate;
    let nearest = dates[0];
    let best = Math.abs(parseDayMs(nearest) - parseDayMs(targetDate));
    for (const d of dates) {
      const diff = Math.abs(parseDayMs(d) - parseDayMs(targetDate));
      if (diff < best) { nearest = d; best = diff; }
    }
    return nearest;
  }

  function windowEndDate(win = graphWindow()) {
    return graphDates()[win.endIdx] || null;
  }

  function isDateInWindow(date, win = graphWindow()) {
    const dates = graphDates();
    return Boolean(date && dates.length && date >= dates[win.startIdx] && date <= dates[win.endIdx]);
  }

  function selectGraphDate(date, { immediate = false } = {}) {
    const dates = graphDates();
    if (!date || !dates.length) return;
    const win = graphWindow();
    const snapped = nearestHistoryDate(date, dates.slice(win.startIdx, win.endIdx + 1));
    if (snapped === state.selectedHistoryDate && !immediate) return;
    state.selectedHistoryDate = snapped;
    renderGraphHeader();
    renderPeriodPager();
    valuationChart.draw();
    scheduleGraphSnapshot(immediate);
  }

  function setGraphWindow(rangeKey, offset) {
    state.selectedChartRange = rangeKey;
    state.chartRangeOffset = offset;
    renderChartRangeButtons();
    valuationChart.hoverIndex = null;
    startChartReveal(valuationChart);
    selectGraphDate(windowEndDate(), { immediate: true });
  }

  function shiftGraphPeriod(delta) {
    const win = graphWindow();
    if ((delta < 0 && !win.canPrev) || (delta > 0 && !win.canNext)) return;
    state.chartRangeOffset = Math.min(0, state.chartRangeOffset + delta);
    valuationChart.hoverIndex = null;
    startChartReveal(valuationChart);
    selectGraphDate(windowEndDate(), { immediate: true });
  }

  function jumpToGraphDate(date) {
    const dates = graphDates();
    if (!date || !dates.length) return;
    const target = nearestHistoryDate(date, dates);
    let offset = 0;
    while (offset > -5000) {
      const bounds = getChartWindowBounds(state.selectedChartRange, dates, offset);
      if (!bounds.shiftable || target > bounds.start || (bounds.calendar && target >= bounds.start)) break;
      offset -= 1;
    }
    if (offset !== state.chartRangeOffset) startChartReveal(valuationChart);
    state.chartRangeOffset = offset;
    selectGraphDate(target, { immediate: true });
  }

  function renderGraphHeader() {
    const header = $('tt-header-display');
    const data = state.latestPortfolioHistoryData;
    const idx = data?.dates?.indexOf(state.selectedHistoryDate) ?? -1;
    if (idx < 0) {
      header.innerHTML = '';
      $('graph-legend').innerHTML = '';
      return;
    }
    const win = graphWindow();
    const value = data.values[idx] ?? 0;
    const invested = data.invested[idx];
    const openCost = (data.open_cost || [])[idx];
    const period = graphPeriodChange(idx, win);
    const investedPnl = invested != null ? value - invested : null;
    const investedPct = invested > 0 ? (investedPnl / invested) * 100 : null;
    const openPnl = openCost != null ? value - openCost : null;
    const openPct = openCost > 0 ? (openPnl / openCost) * 100 : null;

    header.innerHTML = summaryHtml({
      label: 'Portfolio value',
      value,
      change: period ? { ...period, horizon: win.label } : null,
    });
    // The blue line is the value above; the legend names the other two lines
    // and carries their figures for the selected day.
    $('graph-legend').innerHTML = summarySecondaryHtml([
      { kind: 'invested', label: 'Invested', value: invested, eur: investedPnl, pct: investedPct },
      { kind: 'open', label: 'Open', value: openCost, eur: openPnl, pct: openPct },
    ], 'legend-values');
    setCompactHeader('graph', value, period ? { ...period, horizon: win.label } : null);
  }

  function formatPagerDate(date, withYear = true) {
    return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
    });
  }

  function renderPeriodPager() {
    const dates = graphDates();
    const label = $('tt-period-label');
    const input = $('tt-date');
    if (!dates.length || !state.selectedHistoryDate) {
      label.textContent = '—';
      return;
    }
    const win = graphWindow();
    const fromDate = win.hasBaseline ? win.baseline.date : dates[win.startIdx];
    const sameYear = fromDate.slice(0, 4) === state.selectedHistoryDate.slice(0, 4);
    label.textContent = fromDate === state.selectedHistoryDate
      ? formatPagerDate(fromDate)
      : `${formatPagerDate(fromDate, !sameYear)} – ${formatPagerDate(state.selectedHistoryDate)}`;
    input.min = dates[0];
    input.max = dates[dates.length - 1];
    if (input.value !== state.selectedHistoryDate) input.value = state.selectedHistoryDate;

    const periodName = { '1W': 'week', '1M': 'month', YTD: 'year', '1Y': 'year', '3Y': '3 years', '5Y': '5 years' }[state.selectedChartRange] || 'period';
    const prev = $('tt-prev');
    const next = $('tt-next');
    prev.disabled = !win.canPrev;
    next.disabled = !win.canNext;
    prev.hidden = !win.shiftable;
    next.hidden = !win.shiftable;
    prev.setAttribute('aria-label', `Previous ${periodName}`);
    next.setAttribute('aria-label', `Next ${periodName}`);
    prev.title = `Previous ${periodName}`;
    next.title = `Next ${periodName}`;
  }

  let graphSnapshotTimer = null;
  let graphSnapshotToken = 0;

  function scheduleGraphSnapshot(immediate = false) {
    clearTimeout(graphSnapshotTimer);
    if (!state.selectedHistoryDate) return;
    graphSnapshotTimer = setTimeout(() => {
      const win = graphWindow();
      loadTimeTravel(state.selectedHistoryDate, win.baseline.date);
    }, immediate ? 0 : 220);
  }

  async function loadTimeTravel(date, from) {
    const container = $('tt-content');
    const token = ++graphSnapshotToken;
    if (!container.children.length) container.innerHTML = '<div class="muted-empty">Loading snapshot…</div>';
    container.classList.add('is-loading');
    try {
      const params = new URLSearchParams({ date, includeOtherBrokers: state.includeOtherBrokers ? '1' : '0' });
      if (from) params.set('from', from);
      const resp = await fetch(`/api/time-travel?${params}`);
      const data = await resp.json();
      if (token !== graphSnapshotToken) return;
      renderTimeTravel(data);
    } catch (err) {
      if (token !== graphSnapshotToken) return;
      container.innerHTML = '<div class="muted-empty">Failed to load snapshot.</div>';
      console.error(err);
    } finally {
      if (token === graphSnapshotToken) container.classList.remove('is-loading');
    }
  }

  // Issuer mark for a position: known fund houses get their own tint and
  // short name, anything else its initials on a hue derived from the name.
  const ISSUER_MARKS = [
    [/ishares/i, 'iS', 215, 16],
    [/amundi|lyxor/i, 'Am', 205, 70],
    [/vanguard/i, 'V', 355, 60],
    [/xtrackers|db x-trackers/i, 'Xt', 160, 55],
    [/spdr/i, 'SP', 35, 75],
    [/invesco/i, 'In', 265, 55],
    [/wisdomtree/i, 'WT', 25, 70],
    [/vaneck/i, 'VE', 5, 60],
  ];

  // Next to its issuer mark a name drops the issuer: "iS  MSCI WORLD A".
  function positionTitle(name) {
    const text = String(name || '');
    if (!ISSUER_MARKS.some(([pattern]) => pattern.test(text))) return text;
    const stripped = text.replace(/^(ishares|amundi|lyxor|vanguard|db x-trackers|xtrackers|spdr|invesco|wisdomtree|vaneck)\b[\s-]*/i, '');
    return stripped || text;
  }

  function positionAvatar(name) {
    const text = String(name || '');
    const known = ISSUER_MARKS.find(([pattern]) => pattern.test(text));
    let mark;
    let hue;
    let sat;
    if (known) {
      [, mark, hue, sat] = known;
    } else {
      const words = text.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
      mark = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
      hue = [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
      sat = 45;
    }
    return `<span class="position-avatar" style="--avatar-h: ${hue}; --avatar-s: ${sat}%" aria-hidden="true">${escapeHtml(mark)}</span>`;
  }

  function isTracker(h) {
    return TRACKER_KEYWORDS.some((kw) => (h.name || '').toLowerCase().includes(kw.toLowerCase()));
  }

  function renderTimeTravel(data = state.timeTravelData) {
    const container = $('tt-content');
    if (!data) return;
    state.timeTravelData = data;
    if (!data.holdings?.length) {
      container.innerHTML = '<div class="muted-empty">No holdings on this date.</div>';
      return;
    }

    const horizon = data.from ? graphWindow().label : null;
    const open = data.holdings.filter((h) => !h.closed);
    const totalValue = open.reduce((sum, h) => sum + (h.total_value_eur || 0), 0);
    const arrowPct = (pct) => `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`;

    // Same row as the overview: position, then the instrument's own move over
    // the period next to its price, then what the shares still held made.
    const renderRow = (h) => {
      const key = `${h.is_manual ? 'm' : 's'}-${h.id}${h.closed ? '-sold' : ''}`;
      const weight = totalValue > 0 && !h.closed ? ((h.total_value_eur || 0) / totalValue) * 100 : 0;
      const stockChange = h.price_change_pct != null
        ? `<span class="price-change ${numberClass(h.price_change_pct)}" title="The ${escapeHtml(positionTitle(h.name))} price over ${escapeHtml(horizon || 'the period')}">${arrowPct(h.price_change_pct)}</span>`
        : '';
      const sold = h.period_sold;
      // One figure, following the shared %/€ switch like the overview rows.
      const gain = h.closed ? { eur: sold?.eur, pct: sold?.pct } : { eur: h.period_change_eur, pct: h.period_change_pct };
      const shown = state.holdingChangeMode === 'eur' || gain.pct == null
        ? (gain.eur != null ? formatSignedEur(gain.eur) : null)
        : formatPct(gain.pct);
      const change = shown
        ? `<span class="holding-change ${numberClass(gain.eur ?? gain.pct)}" title="${gain.eur != null ? formatSignedEur(gain.eur) : ''}${gain.pct != null ? ` · ${formatPct(gain.pct)}` : ''}">${shown}</span>`
        : '';
      const meta = [
        escapeHtml(h.exchange || h.symbol || ''),
        h.closed ? null : `${formatShares(h.shares)} sh`,
      ].filter(Boolean).join(' · ');
      return `
        <div class="holding-row is-clickable${h.closed ? ' is-closed' : ''}" data-perf-key="${key}" style="--weight: ${weight.toFixed(2)}%">
          <div class="holding-info with-avatar">
            ${positionAvatar(h.name)}
            <div class="with-avatar-text">
              <div class="holding-name" title="${escapeHtml(h.name)}">${escapeHtml(positionTitle(h.name))}</div>
              <div class="holding-meta">${meta}${stockChange ? `<span class="holding-meta-extra"> · stock ${stockChange}</span>` : ''}</div>
            </div>
          </div>
          <div class="holding-price">
            <div class="price-main">${h.price != null ? formatPrice(h.price, h.currency) : '—'}</div>
            ${stockChange}
          </div>
          <div class="holding-value">
            <div class="value-main">${h.closed ? '<span class="muted">Sold</span>' : h.total_value_eur != null ? formatEur(h.total_value_eur) : '—'}</div>
            ${change}
          </div>
        </div>
      `;
    };

    const renderGroup = (title, items) => {
      if (!items.length) return '';
      const value = items.reduce((sum, h) => sum + (h.total_value_eur || 0), 0);
      return `
        <div class="holdings-group">
          <span>${title}</span>
          ${value > 0 ? `<span>${formatEur(value)}</span>` : ''}
        </div>
        ${items.map(renderRow).join('')}
      `;
    };

    const kindOf = (h) => h.kind || (h.is_manual ? 'manual' : isTracker(h) ? 'tracker' : 'stock');
    const groups = [
      ['Stocks', open.filter((h) => kindOf(h) === 'stock')],
      ['ETFs', open.filter((h) => kindOf(h) === 'tracker')],
      ['Other brokers', open.filter((h) => kindOf(h) === 'manual')],
      [`Sold ${horizon === 'YTD' ? 'this year' : `in ${horizon || 'period'}`}`, data.holdings.filter((h) => h.closed)],
    ].filter(([, items]) => items.length);
    // A single group needs no label; the panel already says what it is.
    const labelled = groups.length > 1 || groups[0]?.[0].startsWith('Sold');

    container.innerHTML = `
      <div class="holdings-list tt-holdings">
        <div class="holdings-head">
          <span>Position</span>
          <span style="text-align:right">${horizon ? `Stock ${escapeHtml(horizon)}` : 'Price'}</span>
          <span style="text-align:right">${horizon ? `Value · ${escapeHtml(horizon)}` : 'Value'}</span>
        </div>
        ${labelled ? groups.map(([title, items]) => renderGroup(title, items)).join('') : groups.map(([, items]) => items.map(renderRow).join('')).join('')}
      </div>
    `;
  }

  async function loadPortfolioValuationChart({ fromCache = false } = {}) {
    try {
      const url = `/api/portfolio-valuation-history${otherBrokersQueryParam()}`;
      const data = fromCache ? readCache(url) : await fetchJson(url);
      if (!data?.dates?.length) return false;

      const previous = state.latestPortfolioHistoryData;
      const followLatest = !previous
        || (state.chartRangeOffset === 0 && state.selectedHistoryDate === previous.dates[previous.dates.length - 1]);
      state.portfolioHistoryDates = data.dates;
      state.latestPortfolioHistoryData = data;
      renderPortfolioHistoryTable(data);

      valuationChart.init();
      renderChartRangeButtons();
      updateScaleButton();
      const win = graphWindow();
      const date = followLatest || !data.dates.includes(state.selectedHistoryDate)
        ? windowEndDate(win)
        : state.selectedHistoryDate;
      state.selectedHistoryDate = null;
      if (!previous) startChartReveal(valuationChart);
      selectGraphDate(date, { immediate: true });
      return true;
    } catch (err) {
      console.error('Failed to load chart', err);
      await checkServerStatus();
      return false;
    }
  }

  async function loadOtherBrokersPanel() {
    const container = $('other-brokers-content');
    try {
      const resp = await fetch('/api/manual-holdings');
      const data = await resp.json();
      const holdings = data.holdings || [];
      if (!holdings.length) {
        container.innerHTML = '<div class="muted-empty">No other-broker holdings yet.</div>';
        return;
      }
      container.innerHTML = `<div class="broker-list">${holdings.map((h) => {
        const change = h.gain_loss_eur != null
          ? `<div class="tt-holding-change ${numberClass(h.gain_loss_eur)}">${formatSignedEur(h.gain_loss_eur)} (${formatPct(h.gain_loss_percent || 0)})</div>`
          : '';
        const day = h.price_change_pct != null
          ? `<div class="tt-holding-change ${numberClass(h.price_change_pct)}">1d ${formatPct(h.price_change_pct)}</div>`
          : '';
        return `
          <div class="broker-row">
            <div class="broker-main">
              <div class="broker-name">${escapeHtml(h.name)}</div>
              <div class="broker-meta">${escapeHtml(h.symbol)} · ${h.shares} shares · Cost ${formatEur(h.cost_basis_eur)} · ${escapeHtml(h.broker || 'Other')}</div>
            </div>
            <div class="broker-right">
              <div class="tt-holding-value">${h.total_value_eur != null ? formatEur(h.total_value_eur) : '—'}</div>
              ${change}${day}
              <button class="btn btn-ghost" data-delete-holding="${h.id}" type="button">Delete</button>
            </div>
          </div>
        `;
      }).join('')}</div>`;
    } catch (err) {
      console.error('Failed to load other brokers', err);
    }
  }

  async function refreshOtherBrokersData() {
    await Promise.all([loadOtherBrokersPanel(), loadCapitalGains()]);
    if (state.includeOtherBrokers) {
      await Promise.all([
        loadPortfolioSummary(),
        loadPortfolioValuationChart(),
        loadHoldings(),
        loadPerformance(),
      ]);
    }
  }

  async function refreshLivePrices(show = false) {
    const btn = $('live-refresh-btn');
    btn.classList.add('loading');
    try {
      if (show) showToast('Fetching live prices…', true);
      const resp = await fetch('/api/refresh-live-prices', { method: 'POST' });
      const result = await resp.json();
      if (result.success) {
        await Promise.all([
          loadPortfolioSummary(),
          loadPortfolioValuationChart(),
          loadHoldings(),
          loadPerformance(),
          loadOtherBrokersPanel(),
          loadCapitalGains(),
        ]);
        if (show) showToast(`Live prices updated (${result.count || 0} symbols)`, true);
      } else if (show) {
        showToast('Failed to refresh live prices', false);
      }
    } catch (err) {
      await checkServerStatus();
      if (show) showToast(`Error refreshing live prices: ${err.message}`, false);
    } finally {
      btn.classList.remove('loading');
    }
  }

  function updateEmptyState() {
    const empty = !state.hasData;
    $('empty-state').style.display = empty ? 'flex' : 'none';
    $('overview-content').style.display = empty ? 'none' : 'block';
    updateCompactHeader();
  }

  async function uploadFile(input, endpoint, startMessage) {
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    state.uploadInProgress = true;
    let current = 10;
    showProgress(startMessage, current);
    const tick = setInterval(() => {
      if (current < 90) {
        current = Math.min(90, current + Math.random() * 12);
        showProgress(current > 60 ? 'Fetching market prices…' : current > 30 ? 'Processing file…' : startMessage, current);
      }
    }, 500);
    try {
      const resp = await fetch(endpoint, { method: 'POST', body: formData });
      const result = await resp.json();
      clearInterval(tick);
      if (result.success) {
        showProgress('Done', 100);
        setTimeout(() => {
          hideProgress();
          showToast(result.message + ' — reloading…', true);
          setTimeout(() => window.location.reload(), 1800);
        }, 600);
      } else {
        hideProgress();
        showToast(result.message, false);
      }
    } catch (err) {
      clearInterval(tick);
      hideProgress();
      showToast(`Upload failed: ${err.message}`, false);
    } finally {
      state.uploadInProgress = false;
      input.value = '';
    }
  }

  async function updateMarketData() {
    closeOverlay('settings-overlay');
    state.uploadInProgress = true;
    showToast('Fetching latest market data…', true);
    try {
      const resp = await fetch('/api/update-market-data', { method: 'POST' });
      const result = await resp.json();
      if (result.success) {
        showToast(result.message + ' — reloading…', true);
        setTimeout(() => window.location.reload(), 1800);
      } else {
        showToast(result.message, false);
      }
    } catch (err) {
      showToast(`Error updating market data: ${err.message}`, false);
    } finally {
      state.uploadInProgress = false;
    }
  }

  function openOverlay(id) {
    const overlay = $(id);
    clearTimeout(Number(overlay.dataset.closeTimer));
    overlay.classList.remove('is-closing');
    overlay.classList.add('show');
  }

  function closeOverlay(id) {
    const overlay = $(id);
    if (!overlay.classList.contains('show') || overlay.classList.contains('is-closing')) return;
    overlay.classList.add('is-closing');
    const timer = setTimeout(() => {
      overlay.classList.remove('show', 'is-closing');
      delete overlay.dataset.closeTimer;
    }, 190);
    overlay.dataset.closeTimer = String(timer);
  }

  function openSettings() {
    openOverlay('settings-overlay');
    requestAnimationFrame(() => syncSegIndicator($('theme-mode')));
    loadGmailStatus();
    loadMailImports();
  }

  async function loadMailImports() {
    try {
      const data = await (await fetch('/api/imports')).json();
      const imports = data.imports || [];
      $('mail-imports').innerHTML = imports.length ? imports.map((batch) => `
        <div class="settings-row settings-row-static">
          <svg class="settings-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M4 8l8 6 8-6"/></svg>
          <span><strong title="${escapeHtml(batch.label || '')}">${escapeHtml(batch.label || 'Mail import')}</strong><small>${new Date(batch.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${batch.transaction_count} ${batch.transaction_count === 1 ? 'fill' : 'fills'}</small></span>
          <button class="btn btn-outline btn-tiny" type="button" data-undo-import="${batch.id}" data-count="${batch.transaction_count}">Undo</button>
        </div>`).join('') : `
        <div class="settings-row settings-row-static">
          <svg class="settings-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
          <span><strong>No imports to undo</strong><small>Fills you add from a scan will show up here</small></span>
          <span></span>
        </div>`;
    } catch (err) {
      console.error('Failed to load mail imports', err);
    }
  }

  function undoMailImport(id, count) {
    closeOverlay('settings-overlay');
    openConfirm(
      'Undo mail import',
      `Remove the ${count} ${count === 1 ? 'fill' : 'fills'} this import added? Scan mail again to add them back.`,
      'Undo import',
      async () => {
        try {
          const result = await (await fetch(`/api/imports/${id}/undo`, { method: 'POST' })).json();
          showToast(result.message || (result.success ? 'Import undone' : 'Undo failed'), result.success);
          if (result.success) setTimeout(() => window.location.reload(), 1200);
        } catch (err) {
          showToast(`Undo failed: ${err.message}`, false);
        }
      },
    );
  }

  async function loadGmailStatus() {
    try {
      const resp = await fetch('/api/gmail/status');
      const status = await resp.json();
      if (!status.success) throw new Error(status.message || 'Failed to load Gmail status');
      renderGmailStatus(status);
      return status;
    } catch (err) {
      $('gmail-status-copy').textContent = `Could not load Gmail status: ${err.message}`;
      return null;
    }
  }

  function renderGmailStatus(status) {
    const copy = $('gmail-status-copy');
    const setup = $('gmail-setup');
    const account = $('gmail-account');
    const scanBtn = $('gmail-scan-btn');
    const sidebarScan = $('sidebar-scan-btn');
    const mobileScan = $('mobile-scan-btn');
    const disconnectBtn = $('gmail-disconnect-btn');

    setup.hidden = Boolean(status.connected);
    account.hidden = !status.connected;
    scanBtn.hidden = !status.connected;
    if (sidebarScan) sidebarScan.hidden = !status.connected;
    if (mobileScan) mobileScan.hidden = !status.connected;
    disconnectBtn.hidden = !status.connected;
    $('mail-imports-block').hidden = !status.connected;

    if (status.connected) {
      $('gmail-account-email').textContent = status.email || 'Connected mailbox';
      const proto = status.secure ? 'SSL/TLS' : 'STARTTLS';
      $('gmail-account-meta').textContent = `${status.host}:${status.port} · ${proto}`;
      $('gmail-scan-meta').textContent = status.lastScan
        ? `Last scan ${new Date(status.lastScan).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
        : 'Not scanned yet';
      copy.textContent = 'Scans add new DEGIRO confirmation fills without replacing history.';
    } else {
      copy.textContent = 'Gmail address plus an app password. The inbox is read over IMAP.';
    }
  }

  async function saveGmailCredentials() {
    const user = $('mailbox-user')?.value.trim();
    const password = $('mailbox-password')?.value.trim();
    const host = $('mailbox-host')?.value.trim();
    const port = parseInt($('mailbox-port')?.value, 10);
    const secure = $('mailbox-secure')?.checked !== false;
    if (!user || !password) {
      showToast('Email and app password are required.', false);
      return;
    }
    const btn = $('gmail-save-credentials');
    btn.classList.add('loading');
    try {
      const resp = await fetch('/api/gmail/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password, host, port, secure }),
      });
      const result = await resp.json();
      if (!result.success) {
        showToast(result.message || 'Could not connect mailbox', false);
        return;
      }
      $('mailbox-password').value = '';
      renderGmailStatus(result);
      showToast(`Connected ${result.email}`, true);
    } catch (err) {
      showToast(`Could not connect mailbox: ${err.message}`, false);
    } finally {
      btn.classList.remove('loading');
    }
  }

  function applyMailboxPreset(name) {
    if (name === 'outlook') {
      $('mailbox-host').value = 'outlook.office365.com';
      $('mailbox-port').value = '993';
      $('mailbox-secure').checked = true;
      return;
    }
    $('mailbox-host').value = 'imap.gmail.com';
    $('mailbox-port').value = '993';
    $('mailbox-secure').checked = true;
  }

  async function scanGmailConfirmations() {
    setSidebarOpen(false);
    closeOverlay('settings-overlay');
    state.uploadInProgress = true;
    let current = 12;
    showProgress('Scanning mailbox confirmations…', current);
    const tick = setInterval(() => {
      if (current < 88) {
        current = Math.min(88, current + Math.random() * 8);
        showProgress('Reading DEGIRO confirmation emails…', current);
      }
    }, 600);
    try {
      const resp = await fetch('/api/gmail/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const result = await resp.json();
      clearInterval(tick);
      hideProgress();
      if (!result.success) {
        showToast(result.message || 'Mailbox scan failed', false);
        return;
      }
      if (!result.fills?.length) {
        showToast(result.message || 'No DEGIRO confirmation emails found', true);
        return;
      }
      openScanPreview(result);
    } catch (err) {
      clearInterval(tick);
      hideProgress();
      showToast(`Mailbox scan failed: ${err.message}`, false);
    } finally {
      state.uploadInProgress = false;
    }
  }

  function fillSideLabel(quantity) {
    return Number(quantity) < 0 ? 'Sell' : 'Buy';
  }

  function formatScanWhen(fill) {
    const match = String(fill.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = match ? `${match[3]}-${match[2]}-${match[1]}` : (fill.date || '');
    const time = fill.time ? String(fill.time).slice(0, 8) : '';
    return [date, time].filter(Boolean).join(' ');
  }

  function fillTimestamp(fill) {
    return `${fill.date || ''}T${fill.time || '00:00:00'}`;
  }

  function openScanPreview(result) {
    const fills = [...(result.fills || [])].sort((a, b) => fillTimestamp(b).localeCompare(fillTimestamp(a)));
    const newFills = fills.filter((fill) => !fill.duplicate);
    const rows = fills.map((fill) => {
      const qty = Math.abs(Number(fill.quantity) || 0);
      const side = fillSideLabel(fill.quantity);
      const when = formatScanWhen(fill);
      const checkbox = fill.duplicate
        ? '<input type="checkbox" disabled>'
        : `<input type="checkbox" data-fill-id="${escapeHtml(fill.id)}" checked>`;
      const flag = fill.duplicate ? '<div class="scan-fill-flag">Already in portfolio</div>' : '';
      return `
        <label class="scan-fill${fill.duplicate ? ' is-duplicate' : ''}">
          ${checkbox}
          <div class="scan-fill-copy">
            <div class="scan-fill-title">${escapeHtml(fill.product || 'Unknown product')}</div>
            <div class="scan-fill-meta">${escapeHtml(side)} ${qty} · ${escapeHtml(fill.isin)} · ${escapeHtml(when)}</div>
            ${flag}
          </div>
          <div class="scan-fill-amount">${formatSignedEur(Number(fill.totalEur) || 0)}</div>
        </label>
      `;
    }).join('');

    const summary = result.newCount
      ? `I found ${result.newCount} fill${result.newCount === 1 ? '' : 's'} that can be added.${result.duplicateCount ? ` ${result.duplicateCount} already in the portfolio.` : ''} Confirm to import the selected ones.`
      : 'Everything I found is already in the portfolio.';

    $('scan-overlay').innerHTML = `
      <div class="dialog dialog-scan" role="dialog" aria-labelledby="scan-title">
        <h3 id="scan-title">Mailbox scan</h3>
        <p class="scan-summary">${escapeHtml(summary)}</p>
        <div class="scan-fills">${rows}</div>
        <div class="dialog-actions">
          <button class="btn btn-outline" data-close-scan type="button">Cancel</button>
          <button class="btn btn-primary" id="scan-import-btn" type="button" ${result.newCount ? '' : 'disabled'}>Add selected</button>
        </div>
      </div>
    `;
    openOverlay('scan-overlay');
    const importBtn = $('scan-import-btn');
    if (importBtn && result.newCount) {
      importBtn.onclick = () => confirmScanImport(result.token);
    }
  }

  async function confirmScanImport(token) {
    const fillIds = [...document.querySelectorAll('#scan-overlay [data-fill-id]:checked')].map((el) => el.dataset.fillId);
    if (!fillIds.length) {
      showToast('Select at least one fill to add.', false);
      return;
    }
    closeOverlay('scan-overlay');
    state.uploadInProgress = true;
    showProgress('Adding selected fills…', 30);
    try {
      const resp = await fetch('/api/gmail/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, fillIds }),
      });
      const result = await resp.json();
      if (!result.success) {
        hideProgress();
        showToast(result.message || 'Import failed', false);
        return;
      }
      showProgress('Done', 100);
      setTimeout(() => {
        hideProgress();
        showToast(result.message + (result.newTransactions ? ' — reloading…' : ''), true);
        if (result.newTransactions > 0) {
          setTimeout(() => window.location.reload(), 1600);
        }
      }, 400);
    } catch (err) {
      hideProgress();
      showToast(`Import failed: ${err.message}`, false);
    } finally {
      state.uploadInProgress = false;
    }
  }

  function openConfirm(title, message, confirmLabel, onConfirm) {
    $('confirm-overlay').innerHTML = `
      <div class="dialog" role="dialog">
        <h3>${title}</h3>
        <p class="muted-empty" style="text-align:left;padding:0 0 0.5rem;">${message}</p>
        <div class="dialog-actions">
          <button class="btn btn-outline" data-close-confirm type="button">Cancel</button>
          <button class="btn btn-destructive" id="confirm-action" type="button">${confirmLabel}</button>
        </div>
      </div>
    `;
    openOverlay('confirm-overlay');
    $('confirm-action').onclick = () => {
      closeOverlay('confirm-overlay');
      onConfirm();
    };
  }

  function openManualModal() {
    const today = new Date().toISOString().split('T')[0];
    $('manual-overlay').innerHTML = `
      <div class="dialog" role="dialog">
        <h3>Add other-broker holding</h3>
        <div class="form-group"><label for="mh-name">Name</label><input id="mh-name" type="text" placeholder="e.g. Vanguard FTSE All-World"></div>
        <div class="form-group"><label for="mh-ticker">Yahoo ticker</label><input id="mh-ticker" type="text" placeholder="e.g. VWCE.DE"></div>
        <div class="form-group"><label for="mh-quantity">Quantity</label><input id="mh-quantity" type="number" step="0.001" min="0" placeholder="10"></div>
        <div class="form-group">
          <label>Price input</label>
          <div class="radio-row">
            <label><input type="radio" name="mh-price-mode" value="total" checked> Total amount</label>
            <label><input type="radio" name="mh-price-mode" value="per-share"> Per share</label>
          </div>
        </div>
        <div class="form-group"><label for="mh-price" id="mh-price-label">Total amount (€)</label><input id="mh-price" type="number" step="0.01" min="0" placeholder="10000"></div>
        <div class="form-group"><label for="mh-date">Purchase date</label><input id="mh-date" type="date" value="${today}"></div>
        <div class="form-group"><label for="mh-broker">Broker (optional)</label><input id="mh-broker" type="text" placeholder="e.g. Bolero"></div>
        <div class="dialog-actions">
          <button class="btn btn-outline" data-close-manual type="button">Cancel</button>
          <button class="btn btn-primary" id="mh-submit" type="button">Add holding</button>
        </div>
      </div>
    `;
    openOverlay('manual-overlay');
  }

  async function submitManualHolding() {
    const name = $('mh-name')?.value.trim();
    const ticker = $('mh-ticker')?.value.trim();
    const quantity = parseFloat($('mh-quantity')?.value);
    const price = parseFloat($('mh-price')?.value);
    const date = $('mh-date')?.value;
    const broker = $('mh-broker')?.value.trim();
    const mode = document.querySelector('input[name="mh-price-mode"]:checked')?.value || 'total';
    if (!name || !ticker || !quantity || quantity <= 0 || !price || price <= 0 || !date) {
      showToast('Fill in all required fields.', false);
      return;
    }
    const body = { display_name: name, yahoo_ticker: ticker, quantity, purchase_date: date, broker: broker || undefined };
    if (mode === 'total') body.purchase_price_total = price;
    else body.purchase_price_per_share = price;
    try {
      const resp = await fetch('/api/manual-holdings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!result.success) {
        showToast(result.message || 'Failed to add holding', false);
        return;
      }
      closeOverlay('manual-overlay');
      await refreshOtherBrokersData();
      showToast('Holding added', true);
    } catch (err) {
      showToast(`Error adding holding: ${err.message}`, false);
    }
  }

  async function deleteManualHolding(id) {
    try {
      const resp = await fetch(`/api/manual-holdings/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const result = await resp.json();
      if (!result.success) {
        showToast(result.message || 'Failed to delete holding', false);
        return;
      }
      await refreshOtherBrokersData();
    } catch (err) {
      showToast(`Error deleting holding: ${err.message}`, false);
    }
  }

  async function purgeDatabase() {
    try {
      const resp = await fetch('/api/purge-database', { method: 'POST' });
      const result = await resp.json();
      if (result.success) {
        clearCache();
        showToast('Database purged — reloading…', true);
        setTimeout(() => window.location.reload(), 1200);
      } else {
        showToast(result.message, false);
      }
    } catch (err) {
      showToast(`Error purging: ${err.message}`, false);
    }
  }

  function findLot(lotId) {
    for (const holding of state.performanceHoldings) {
      const lot = (holding.lots || []).find((item) => item.id === lotId);
      if (lot) return { holding, lot };
    }
    return null;
  }

  function emptyDetail() {
    $('lot-detail-kicker').textContent = 'Detail';
    $('lot-detail-title').textContent = 'Select a position';
    $('lot-detail-meta').innerHTML = '<div class="muted-empty">Click a position or a purchase to see how it has performed.</div>';
    $('lot-chart-block').hidden = true;
    $('perf-expand-btn').hidden = true;
  }

  function showLotChartBlock() {
    $('lot-chart-block').hidden = false;
    $('perf-expand-btn').hidden = false;
    requestAnimationFrame(() => lotChart.draw());
  }

  function renderPositionDetail(holding) {
    const kicker = $('lot-detail-kicker');
    const title = $('lot-detail-title');
    const meta = $('lot-detail-meta');
    if (!holding) {
      emptyDetail();
      return;
    }
    kicker.textContent = holding.kind === 'closed' ? 'Sold position' : 'Position';
    title.textContent = holding.name;
    showLotChartBlock();
    const closed = holding.kind === 'closed';
    meta.innerHTML = `
      <div class="lot-detail-stats">
        <div class="lot-stat">
          <div class="lot-stat-label">${closed ? 'Purchases' : 'Shares'}</div>
          <div class="lot-stat-value">${closed ? holding.lots.length : formatShares(holding.shares)}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">Cost</div>
          <div class="lot-stat-value">${formatEur(holding.cost_eur || 0)}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">${closed ? 'Sold for' : 'Now'}</div>
          <div class="lot-stat-value">${holding.value_eur != null ? formatEur(holding.value_eur) : '—'}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">Gain / loss</div>
          <div class="lot-stat-value ${numberClass(holding.gain_eur)}">${holding.gain_eur != null ? formatSignedEur(holding.gain_eur) : '—'}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">Return</div>
          <div class="lot-stat-value ${numberClass(holding.gain_pct)}">${holding.gain_pct != null ? formatPct(holding.gain_pct) : '—'}</div>
        </div>
      </div>
    `;
  }

  function renderLotDetail(holding, lot) {
    const title = $('lot-detail-title');
    const meta = $('lot-detail-meta');
    if (!holding || !lot) {
      emptyDetail();
      return;
    }
    $('lot-detail-kicker').textContent = 'Purchase';
    title.textContent = holding.name;
    showLotChartBlock();
    const closed = holding.kind === 'closed' || lot.realized;
    const remainingNote = closed
      ? (lot.remaining_qty !== lot.original_qty
        ? `${formatShares(lot.remaining_qty)} of ${formatShareCount(lot.original_qty)} sold`
        : formatShareCount(lot.remaining_qty))
      : (lot.remaining_qty !== lot.original_qty
        ? `${formatShares(lot.remaining_qty)} of ${formatShareCount(lot.original_qty)} remaining`
        : formatShareCount(lot.remaining_qty));
    const quantity = Number(lot.remaining_qty) || 0;
    const purchaseValue = lot.purchase_value_eur != null
      ? Number(lot.purchase_value_eur)
      : (lot.currency === 'EUR' && lot.buy_price != null ? quantity * Number(lot.buy_price) : null);
    const costs = lot.costs_eur != null
      ? Number(lot.costs_eur)
      : (purchaseValue != null ? Math.max(0, Number(lot.cost_eur || 0) - purchaseValue) : null);
    const breakEvenPrice = lot.break_even_price != null
      ? Number(lot.break_even_price)
      : (!closed && lot.currency === 'EUR' && quantity > 0 ? Number(lot.cost_eur || 0) / quantity : null);
    const priceMove = lot.price_move_eur != null
      ? Number(lot.price_move_eur)
      : (!closed && lot.currency === 'EUR' && holding.latest_price != null && lot.buy_price != null
        ? quantity * (Number(holding.latest_price) - Number(lot.buy_price))
        : null);
    const fxImpact = lot.fx_impact_eur != null ? Number(lot.fx_impact_eur) : null;
    const costBreakdown = `
      <div class="lot-cost-card">
        <div class="lot-cost-title">Cost breakdown</div>
        <div class="lot-cost-grid">
          <div class="lot-cost-item"><span>Buy / share</span><strong>${lot.buy_price != null ? formatPrice(lot.buy_price, lot.currency) : '—'}</strong></div>
          ${closed
            ? `<div class="lot-cost-item"><span>Purchase value</span><strong>${purchaseValue != null ? formatEur(purchaseValue) : '—'}</strong></div>`
            : `<div class="lot-cost-item"><span>Live / share</span><strong>${holding.latest_price != null ? formatPrice(holding.latest_price, holding.currency) : '—'}</strong></div>`}
          <div class="lot-cost-item"><span>Costs</span><strong>${costs != null ? formatEur(costs) : '—'}</strong></div>
          ${closed ? '' : `<div class="lot-cost-item"><span>Break-even / share</span><strong>${breakEvenPrice != null ? formatPrice(breakEvenPrice, lot.currency) : '—'}</strong></div>`}
        </div>
        ${!closed && priceMove != null ? `
          <div class="lot-cost-equation">
            <span>Price move <strong class="${numberClass(priceMove)}">${formatSignedEur(priceMove)}</strong></span>
            ${fxImpact != null && Math.abs(fxImpact) >= 0.005 ? `<span>FX <strong class="${numberClass(fxImpact)}">${formatSignedEur(fxImpact)}</strong></span>` : ''}
            <span>Costs <strong class="negative">-${formatEur(costs || 0)}</strong></span>
            <span class="lot-cost-net">Net <strong class="${numberClass(lot.gain_eur)}">${lot.gain_eur != null ? formatSignedEur(lot.gain_eur) : '—'}</strong></span>
          </div>` : ''}
      </div>`;
    const closedNote = closed
      ? '<div class="lot-closed-note">Realized P/L from this purchase through the sell.</div>'
      : '';
    meta.innerHTML = `
      <div class="lot-detail-stats">
        <div class="lot-stat">
          <div class="lot-stat-label">Bought</div>
          <div class="lot-stat-value">${formatDay(lot.date)}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">${closed ? 'Sold' : 'Shares'}</div>
          <div class="lot-stat-value">${closed ? formatDay(lot.sell_date) : remainingNote}</div>
        </div>
        ${closed ? `<div class="lot-stat">
          <div class="lot-stat-label">Shares</div>
          <div class="lot-stat-value">${remainingNote}</div>
        </div>` : ''}
        <div class="lot-stat">
          <div class="lot-stat-label">Total cost</div>
          <div class="lot-stat-value">${formatEur(lot.cost_eur || 0)}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">${closed ? 'Sold for' : 'Current value'}</div>
          <div class="lot-stat-value">${lot.value_eur != null ? formatEur(lot.value_eur) : '—'}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">Gain / loss</div>
          <div class="lot-stat-value ${numberClass(lot.gain_eur)}">${lot.gain_eur != null ? formatSignedEur(lot.gain_eur) : '—'}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">Return</div>
          <div class="lot-stat-value ${numberClass(lot.gain_pct)}">${lot.gain_pct != null ? formatPct(lot.gain_pct) : '—'}</div>
        </div>
      </div>
      ${costBreakdown}
      ${closedNote}
    `;
  }

  // Purchases unfold under their position: the list renders at once, the
  // height and chevron are eased from the old state to the new one.
  function togglePerfLots(key) {
    const opening = state.perfCollapsed[key] !== false;
    const animate = Boolean(Element.prototype.animate)
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    const parts = () => {
      const holding = document.getElementById(`perf-${key}`);
      return { lots: holding?.querySelector('.perf-lots'), chevron: holding?.querySelector('.perf-chevron svg') };
    };

    if (opening) {
      state.perfCollapsed[key] = false;
      renderPerformance();
      const { lots, chevron } = parts();
      if (!animate || !lots) return;
      lots.animate(
        [{ height: '0px', opacity: 0 }, { height: `${lots.scrollHeight}px`, opacity: 1 }],
        { duration: 260, easing },
      );
      chevron?.animate([{ transform: 'rotate(-90deg)' }, { transform: 'rotate(0deg)' }], { duration: 200, easing });
      return;
    }

    const { lots, chevron } = parts();
    const finish = () => {
      state.perfCollapsed[key] = true;
      renderPerformance();
    };
    if (!animate || !lots) {
      finish();
      return;
    }
    chevron?.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-90deg)' }], { duration: 200, easing, fill: 'forwards' });
    lots.animate(
      [{ height: `${lots.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0, marginBottom: '0px' }],
      { duration: 220, easing, fill: 'forwards' },
    ).finished.then(finish, finish);
  }

  function renderPerformance() {
    const container = $('perf-holdings');
    const holdings = state.performanceHoldings;
    if (!holdings.length) {
      container.innerHTML = '<div class="muted-empty">No open purchases yet.</div>';
      emptyDetail();
      return;
    }

    const groups = [
      { id: 'tracker', title: 'Trackers', items: holdings.filter((h) => h.kind === 'tracker') },
      { id: 'stock', title: 'Stocks', items: holdings.filter((h) => h.kind === 'stock') },
      { id: 'manual', title: 'Other brokers', items: holdings.filter((h) => h.kind === 'manual') },
      { id: 'closed', title: 'Sold positions', items: holdings.filter((h) => h.kind === 'closed').sort((a, b) => (a.first_purchase_date || '').localeCompare(b.first_purchase_date || '')) },
    ].filter((g) => g.items.length);

    container.innerHTML = groups.map((group) => {
      const groupCollapsed = group.id === 'closed' && state.perfGroupCollapsed.closed !== false;
      const groupTitle = group.id === 'closed'
        ? `<button class="perf-group-title perf-group-toggle${groupCollapsed ? ' collapsed' : ''}" type="button" data-perf-group-toggle="closed" aria-expanded="${groupCollapsed ? 'false' : 'true'}">
            <span>${group.title}</span>
            <span class="perf-group-toggle-meta"><span class="perf-group-count">${group.items.length}</span><svg class="perf-group-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
          </button>`
        : `<div class="perf-group-title">${group.title}</div>`;
      const groupItems = groupCollapsed ? '' : group.items.map((h) => {
          const collapsed = state.perfCollapsed[h.key] !== false;
          const closed = h.kind === 'closed';
          const lots = [...(h.lots || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
          const meta = closed
            ? `sold · ${h.lots.length} purchase${h.lots.length === 1 ? '' : 's'}`
            : `${formatShares(h.shares)} sh · ${formatEur(h.cost_eur || 0)} → ${h.value_eur != null ? formatEur(h.value_eur) : '—'}`;
          return `
            <div class="perf-holding${collapsed ? '' : ' is-open'}" id="perf-${h.key}">
              <div class="perf-holding-row">
                <button class="perf-holding-head" type="button" data-perf-select="${h.key}">
                  <div class="with-avatar">
                    ${positionAvatar(h.name)}
                    <div class="with-avatar-text">
                      <div class="perf-holding-name" title="${escapeHtml(h.name)}">${escapeHtml(positionTitle(h.name))}</div>
                      <div class="perf-holding-meta">${meta}</div>
                    </div>
                  </div>
                  <div class="perf-holding-right">
                    <div class="perf-holding-pct ${numberClass(h.gain_pct)}">${h.gain_pct != null ? formatPct(h.gain_pct) : '—'}</div>
                    <div class="perf-holding-gain ${numberClass(h.gain_eur)}">${h.gain_eur != null ? formatSignedEur(h.gain_eur) : '—'}</div>
                  </div>
                </button>
                <button class="perf-chevron${collapsed ? ' collapsed' : ''}" type="button" data-perf-toggle="${h.key}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Show purchases' : 'Hide purchases'}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              </div>
              ${collapsed ? '' : `
                <div class="perf-lots">
                  ${lots.map((lot) => {
                    const quantity = Number(lot.remaining_qty) || 0;
                    const purchaseValue = lot.purchase_value_eur != null
                      ? Number(lot.purchase_value_eur)
                      : (lot.currency === 'EUR' && lot.buy_price != null ? quantity * Number(lot.buy_price) : null);
                    const costs = lot.costs_eur != null
                      ? Number(lot.costs_eur)
                      : (purchaseValue != null ? Math.max(0, Number(lot.cost_eur || 0) - purchaseValue) : null);
                    // "11 × €43.91 + €1 fee = €483.96": figures carry the line,
                    // operators stay quiet, the total is the answer.
                    const op = (sign) => `<i class="perf-lot-op">${sign}</i>`;
                    const formula = [
                      formatShares(lot.remaining_qty),
                      ...(lot.buy_price != null ? [op('×'), formatPrice(lot.buy_price, lot.currency)] : []),
                      ...(costs != null && costs > 0.004 ? [op('+'), `<span class="perf-lot-result">${formatCompactEur(costs)} <span class="perf-lot-unit">fee</span></span>`] : []),
                      `<wbr><span class="perf-lot-result">${op('=')}<span class="perf-lot-total">${formatEur(lot.cost_eur || 0)}</span></span>`,
                    ].join('');
                    const dateLabel = lot.sell_date
                      ? `${formatDay(lot.date)} → ${formatDay(lot.sell_date)}`
                      : formatDay(lot.date);
                    return `
                    <button class="perf-lot${state.selectedLotId === lot.id ? ' selected' : ''}" type="button" data-lot-id="${escapeHtml(lot.id)}">
                      <div class="perf-lot-main">
                        <div class="perf-lot-date">${dateLabel}</div>
                        <div class="perf-lot-meta">${formula}</div>
                      </div>
                      <div class="perf-lot-right">
                        <div class="perf-lot-pct ${numberClass(lot.gain_pct)}">${lot.gain_pct != null ? formatPct(lot.gain_pct) : '—'}</div>
                        <div class="perf-lot-gain ${numberClass(lot.gain_eur)}">${lot.gain_eur != null ? formatSignedEur(lot.gain_eur) : '—'}</div>
                      </div>
                    </button>
                  `;
                  }).join('')}
                </div>
              `}
            </div>
          `;
        }).join('');
      return `<div class="perf-group">${groupTitle}${groupItems}</div>`;
    }).join('');

    if (state.selectedLotId) {
      const selected = findLot(state.selectedLotId);
      renderLotDetail(selected?.holding, selected?.lot);
    } else if (state.selectedHoldingKey) {
      renderPositionDetail(state.performanceHoldings.find((h) => h.key === state.selectedHoldingKey));
    } else {
      emptyDetail();
    }
  }

  async function loadLotChart(holding, lot) {
    state.lotChartData = null;
    lotChart.draw();
    if (!holding || !lot?.date) return;
    const lotId = lot.id;
    try {
      const path = holding.is_manual
        ? `/api/manual-holdings/${holding.id}/lot-chart`
        : `/api/stock/${holding.id}/lot-chart`;
      const params = new URLSearchParams({ qty: String(lot.remaining_qty), from: lot.date });
      if (lot.sell_date) params.set('to', lot.sell_date);
      const resp = await fetch(`${path}?${params}`);
      const data = await resp.json();
      if (state.selectedLotId !== lotId) return;
      state.lotChartData = {
        dates: data.dates || [],
        values: data.values || [],
        cost: lot.cost_eur,
        mode: 'lot',
      };
      renderLotRangeButtons();
      startChartReveal(lotChart);
      lotChart.draw();
    } catch (err) {
      console.error('Failed to load lot chart', err);
    }
  }

  async function loadPositionChart(holding) {
    state.lotChartData = null;
    lotChart.draw();
    if (!holding) return;
    const key = holding.key;
    try {
      const path = holding.is_manual
        ? `/api/manual-holdings/${holding.id}/position-chart`
        : `/api/stock/${holding.id}/position-chart`;
      const mode = holding.kind === 'closed' ? 'sold' : 'open';
      const resp = await fetch(holding.is_manual ? path : `${path}?mode=${mode}`);
      const data = await resp.json();
      if (state.selectedHoldingKey !== key || state.selectedLotId) return;
      state.lotChartData = {
        dates: data.dates || [],
        values: data.values || [],
        costs: data.costs || null,
        mode: 'position',
      };
      renderLotRangeButtons();
      startChartReveal(lotChart);
      lotChart.draw();
    } catch (err) {
      console.error('Failed to load position chart', err);
    }
  }

  function isCompactView() {
    return window.matchMedia('(max-width: 860px)').matches;
  }

  function revealPerfDetail() {
    if (state.perfOverlayOpen) {
      requestAnimationFrame(() => lotChart.draw());
      return;
    }
    if (!isCompactView()) return;
    setPerfExpanded(true);
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      lotChart.draw();
    });
  }

  async function selectLot(lotId, { scroll = false } = {}) {
    const found = findLot(lotId);
    if (!found) return;
    state.selectedLotId = lotId;
    state.selectedHoldingKey = found.holding.key;
    state.perfCollapsed[found.holding.key] = false;
    renderPerformance();
    revealPerfDetail();
    if (scroll && !isCompactView()) {
      const el = document.getElementById(`perf-${found.holding.key}`);
      el?.scrollIntoView({ block: 'nearest' });
    }
    await loadLotChart(found.holding, found.lot);
  }

  async function selectPosition(key, { scroll = false, expandList = true } = {}) {
    const holding = state.performanceHoldings.find((h) => h.key === key);
    if (!holding) return;
    state.selectedHoldingKey = key;
    state.selectedLotId = null;
    if (expandList) state.perfCollapsed[key] = false;
    renderPerformance();
    revealPerfDetail();
    if (scroll && !isCompactView()) {
      document.getElementById(`perf-${key}`)?.scrollIntoView({ block: 'nearest' });
    }
    await loadPositionChart(holding);
  }

  function syncPerfDetailAction() {
    const btn = $('perf-expand-btn');
    if (state.perfOverlayOpen || state.perfDetailExpanded) {
      btn.hidden = false;
      btn.classList.add('btn-icon');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      btn.setAttribute('aria-label', state.perfOverlayOpen ? 'Close performance detail' : 'Back to holdings');
      btn.title = state.perfOverlayOpen ? 'Close' : 'Back to holdings';
      return;
    }
    btn.classList.remove('btn-icon');
    btn.innerHTML = 'Expand';
    btn.setAttribute('aria-label', 'Expand chart');
    btn.title = '';
  }

  function setPerfExpanded(expanded) {
    state.perfDetailExpanded = expanded;
    $('perf-layout').classList.toggle('is-expanded', expanded);
    syncPerfDetailAction();
    requestAnimationFrame(() => lotChart.draw());
  }

  // On phones the detail is a sheet that grows out of the tapped row and
  // shrinks back into it; dragging the header down dismisses it.
  const SHEET_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  let sheetClosing = null;

  function sheetMotionAllowed() {
    return isCompactView() && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && Boolean(Element.prototype.animate);
  }

  function rowClipInSheet(sheet, trigger) {
    if (!trigger?.isConnected) return null;
    const row = trigger.getBoundingClientRect();
    if (!row.height || row.bottom < 0 || row.top > window.innerHeight) return null;
    const box = sheet.getBoundingClientRect();
    const inset = [row.top - box.top, box.right - row.right, box.bottom - row.bottom, row.left - box.left]
      .map((v) => `${Math.max(0, v)}px`).join(' ');
    return `inset(${inset} round 12px)`;
  }

  function animateSheetIn(sheet, overlay, trigger) {
    if (!sheetMotionAllowed()) return;
    const from = rowClipInSheet(sheet, trigger);
    overlay.animate([{ backgroundColor: 'rgb(0 0 0 / 0)' }, {}], { duration: 320, easing: 'ease-out' });
    if (from) {
      sheet.animate(
        [{ clipPath: from, opacity: 0.55 }, { clipPath: 'inset(0 0 0 0 round 16px 16px 0 0)', opacity: 1 }],
        { duration: 400, easing: SHEET_EASE },
      );
    } else {
      sheet.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 380, easing: SHEET_EASE });
    }
  }

  function animateSheetOut(sheet, overlay, trigger, dragOffset) {
    if (!sheetMotionAllowed()) return null;
    const to = dragOffset ? null : rowClipInSheet(sheet, trigger);
    overlay.animate([{}, { backgroundColor: 'rgb(0 0 0 / 0)' }], { duration: 260, easing: 'ease-in', fill: 'forwards' });
    if (to) {
      return sheet.animate(
        [{ clipPath: 'inset(0 0 0 0 round 16px 16px 0 0)', opacity: 1 }, { clipPath: to, opacity: 0 }],
        { duration: 300, easing: SHEET_EASE, fill: 'forwards' },
      );
    }
    return sheet.animate(
      [{ transform: `translateY(${dragOffset || 0}px)` }, { transform: 'translateY(100%)' }],
      { duration: 260, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
  }

  function finishSheetClose() {
    if (sheetClosing) sheetClosing();
  }

  function closePerformanceOverlay({ fromHistory = false, dragOffset = 0 } = {}) {
    if (!state.perfOverlayOpen) return;
    const shouldPopHistory = state.perfOverlayHistoryEntry && !fromHistory;
    const trigger = state.perfOverlayTrigger;
    const detailPanel = document.querySelector('.panel-lot-detail');
    const overlay = $('performance-overlay');
    const sheet = $('performance-overlay-sheet');

    state.perfOverlayOpen = false;
    state.perfOverlayHistoryEntry = false;
    state.perfOverlayTrigger = null;
    if (shouldPopHistory) history.back();

    let done = false;
    const teardown = () => {
      if (done) return;
      done = true;
      sheetClosing = null;
      sheet.getAnimations().forEach((anim) => anim.cancel());
      overlay.getAnimations().forEach((anim) => anim.cancel());
      sheet.style.transform = '';
      sheet.style.transition = '';
      overlay.classList.remove('show', 'is-preparing', 'is-ready');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('performance-overlay-open');
      document.querySelector('.app').inert = false;
      $('perf-layout').appendChild(detailPanel);
      setPerfExpanded(false);
      requestAnimationFrame(() => trigger?.focus?.({ preventScroll: true }));
    };

    sheet.style.transition = '';
    sheet.style.transform = '';
    const anim = animateSheetOut(sheet, overlay, trigger, dragOffset);
    if (!anim) {
      teardown();
      return;
    }
    sheetClosing = teardown;
    anim.finished.then(teardown, teardown);
  }

  function bindSheetDrag() {
    const overlay = $('performance-overlay');
    const sheet = $('performance-overlay-sheet');
    let drag = null;
    sheet.addEventListener('pointerdown', (e) => {
      if (!state.perfOverlayOpen || !isCompactView() || e.pointerType === 'mouse' || overlay.scrollTop > 0) return;
      if (!e.target.closest('.panel-header') || e.target.closest('button')) return;
      drag = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0 };
      sheet.style.transition = 'none';
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const raw = e.clientY - drag.y0;
      drag.dy = raw > 0 ? raw : raw / 6;
      sheet.style.transform = `translateY(${drag.dy}px)`;
    }, { passive: true });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { dy, t0 } = drag;
      drag = null;
      const velocity = dy / Math.max(1, performance.now() - t0);
      if (dy > 110 || (dy > 30 && velocity > 0.6)) {
        closePerformanceOverlay({ dragOffset: dy });
        return;
      }
      sheet.style.transition = 'transform 280ms var(--motion-spring)';
      sheet.style.transform = '';
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  async function openHoldingPerformance(key, trigger = null) {
    let holding = state.performanceHoldings.find((item) => item.key === key);
    if (!holding) {
      await loadPerformance();
      holding = state.performanceHoldings.find((item) => item.key === key);
    }
    if (!holding) return;
    finishSheetClose();

    state.perfOverlayTrigger = trigger || document.activeElement;
    state.perfOverlayOpen = true;
    const overlay = $('performance-overlay');
    const sheet = $('performance-overlay-sheet');
    sheet.appendChild(document.querySelector('.panel-lot-detail'));
    overlay.classList.remove('is-ready');
    overlay.classList.add('show', 'is-preparing');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('performance-overlay-open');
    document.querySelector('.app').inert = true;
    const historyState = history.state && typeof history.state === 'object' ? history.state : {};
    history.pushState({ ...historyState, performanceOverlay: true }, '');
    state.perfOverlayHistoryEntry = true;
    syncPerfDetailAction();

    const selection = selectPosition(key, { expandList: false });
    requestAnimationFrame(() => {
      if (!state.perfOverlayOpen) return;
      lotChart.draw();
      requestAnimationFrame(() => {
        if (!state.perfOverlayOpen) return;
        overlay.classList.remove('is-preparing');
        overlay.classList.add('is-ready');
        animateSheetIn(sheet, overlay, state.perfOverlayTrigger);
        sheet.focus({ preventScroll: true });
        lotChart.draw();
      });
    });
    await selection;
    if (state.perfOverlayOpen) requestAnimationFrame(() => lotChart.draw());
  }

  async function loadPerformance({ fromCache = false } = {}) {
    try {
      const url = `/api/performance${otherBrokersQueryParam()}`;
      const data = fromCache ? readCache(url) : await fetchJson(url);
      if (!data) return;
      state.performanceHoldings = data.holdings || [];
      if (state.selectedLotId && !findLot(state.selectedLotId)) state.selectedLotId = null;
      if (state.selectedHoldingKey && !state.performanceHoldings.some((h) => h.key === state.selectedHoldingKey)) {
        state.selectedHoldingKey = null;
      }
      if (!state.selectedLotId && !state.selectedHoldingKey) state.lotChartData = null;
      renderPerformance();
      lotChart.init();
      if (state.selectedLotId) {
        const found = findLot(state.selectedLotId);
        if (found) await loadLotChart(found.holding, found.lot);
      } else if (state.selectedHoldingKey) {
        const holding = state.performanceHoldings.find((h) => h.key === state.selectedHoldingKey);
        if (holding) await loadPositionChart(holding);
      }
    } catch (err) {
      console.error('Failed to load performance', err);
    }
  }

  // ─── Capital gains tax ─────────────────────────────────────────────
  // The server walks every sale FIFO against its tax basis; the saldo, the
  // exemption and what-if sales are worked out here so they react instantly.
  const TAX_ADJUST_KEY = 'taxAdjustments';
  const TAX_SIMS_KEY = 'taxSimulations';

  function readStored(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeStored(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage full or unavailable */ }
  }

  const TAX_BASIS_LABELS = {
    purchase: 'purchase price',
    photo: 'value on 31 Dec 2025',
    historical: 'higher purchase price',
    'no-photo': 'purchase price (no 31 Dec 2025 price)',
  };

  function currentTaxYear() {
    return new Date().getFullYear();
  }

  function taxYears() {
    const data = state.capitalGains;
    if (!data) return [];
    const first = Number(data.rules.start.slice(0, 4));
    const last = Math.max(currentTaxYear(), ...data.sales.map((s) => s.year));
    const years = [];
    for (let y = first; y <= last; y += 1) years.push(y);
    return years;
  }

  // Mirrors capitalGainPiece on the server for a what-if sale at `priceEur`.
  function taxPiece(lot, qty, priceEur, year) {
    const { rules } = state.capitalGains;
    const proceeds = qty * priceEur;
    const historical = qty * lot.cost_per_share_eur;
    const piece = { acquired: lot.acquired, qty, proceeds_eur: proceeds, historical_basis_eur: historical, photo_basis_eur: null };
    if (lot.acquired >= rules.start) return { ...piece, basis_eur: historical, method: 'purchase', gain_eur: proceeds - historical };
    if (lot.photo_per_share_eur == null) return { ...piece, basis_eur: historical, method: 'no-photo', gain_eur: proceeds - historical };
    const photo = qty * lot.photo_per_share_eur;
    piece.photo_basis_eur = photo;
    if (proceeds <= photo) return { ...piece, basis_eur: photo, method: 'photo', gain_eur: proceeds - photo };
    if (historical > photo && year <= rules.historicalUntilYear) {
      return { ...piece, basis_eur: historical, method: 'historical', gain_eur: Math.max(0, proceeds - historical) };
    }
    return { ...piece, basis_eur: photo, method: 'photo', gain_eur: proceeds - photo };
  }

  function taxPosition(key) {
    return state.capitalGains?.positions.find((p) => p.key === key) || null;
  }

  function wholeShares(position) {
    return !position.is_manual || Number.isInteger(position.shares);
  }

  // What-if sales run one after another over the open lots, oldest first.
  function simulateTaxSales(sims, year) {
    const lotsByKey = new Map();
    return sims.map((sim) => {
      const position = taxPosition(sim.key);
      if (!position || position.price_eur == null) return { ...sim, position, pieces: [], qty: 0, proceeds_eur: 0, basis_eur: 0, gain_eur: 0 };
      if (!lotsByKey.has(sim.key)) lotsByKey.set(sim.key, position.lots.map((lot) => ({ ...lot })));
      const lots = lotsByKey.get(sim.key);
      const pieces = [];
      let left = sim.qty;
      for (const lot of lots) {
        if (left <= 1e-8) break;
        if (lot.qty <= 1e-8) continue;
        const take = Math.min(lot.qty, left);
        pieces.push(taxPiece(lot, take, position.price_eur, year));
        lot.qty -= take;
        left -= take;
      }
      const sum = (k) => pieces.reduce((s, p) => s + p[k], 0);
      return { ...sim, position, pieces, qty: sim.qty - Math.max(0, left), proceeds_eur: sum('proceeds_eur'), basis_eur: sum('basis_eur'), gain_eur: sum('gain_eur') };
    });
  }

  function remainingLots(key, sims) {
    const position = taxPosition(key);
    if (!position) return [];
    const lots = position.lots.map((lot) => ({ ...lot }));
    for (const sim of sims.filter((s) => s.key === key)) {
      let left = sim.qty;
      for (const lot of lots) {
        if (left <= 1e-8) break;
        const take = Math.min(lot.qty, left);
        lot.qty -= take;
        left -= take;
      }
    }
    return lots.filter((lot) => lot.qty > 1e-8);
  }

  function realisedTaxResult(year) {
    const pieces = (state.capitalGains?.sales || []).filter((s) => s.year === year).flatMap((s) => s.pieces);
    return {
      gains: pieces.reduce((s, p) => s + Math.max(0, p.gain_eur), 0),
      losses: pieces.reduce((s, p) => s + Math.min(0, p.gain_eur), 0),
    };
  }

  function taxAdjustment(year) {
    return Number(readStored(TAX_ADJUST_KEY, {})[year]) || 0;
  }

  // €1,000 of an unused exemption carries over per year, up to €15,000 in total.
  function taxExemption(year) {
    const { rules } = state.capitalGains;
    let carry = 0;
    for (let y = Number(rules.start.slice(0, 4)); y < year; y += 1) {
      const exemption = rules.exemption + carry;
      const { gains, losses } = realisedTaxResult(y);
      const used = Math.min(exemption, Math.max(0, gains + losses + taxAdjustment(y)));
      carry = Math.min(rules.exemptionMax - rules.exemption, Math.min(exemption - used, carry + rules.exemptionCarryPerYear));
    }
    return { amount: rules.exemption + carry, carry };
  }

  function taxTotals(year, simulated = []) {
    const { rules } = state.capitalGains;
    const realised = realisedTaxResult(year);
    const simPieces = simulated.flatMap((s) => s.pieces);
    const gains = realised.gains + simPieces.reduce((s, p) => s + Math.max(0, p.gain_eur), 0);
    const losses = realised.losses + simPieces.reduce((s, p) => s + Math.min(0, p.gain_eur), 0);
    const adjustment = taxAdjustment(year);
    const net = gains + losses + adjustment;
    const exemption = taxExemption(year);
    const taxable = Math.max(0, net - exemption.amount);
    return {
      gains,
      losses,
      adjustment,
      net,
      exemption,
      exemptionLeft: Math.max(0, exemption.amount - net),
      taxable,
      tax: taxable * rules.rate,
    };
  }

  // Largest quantity of `key` that still keeps the year's tax at zero.
  function taxFreeQty(key, sims, year) {
    const position = taxPosition(key);
    if (!position || position.price_eur == null) return 0;
    const room = taxTotals(year, simulateTaxSales(sims, year)).exemptionLeft;
    let best = 0;
    let soldBefore = 0;
    let gainBefore = 0;
    for (const lot of remainingLots(key, sims)) {
      const slope = taxPiece(lot, 1, position.price_eur, year).gain_eur;
      const gainAll = gainBefore + slope * lot.qty;
      if (gainAll <= room + 1e-9) best = soldBefore + lot.qty;
      else if (slope > 0 && gainBefore <= room) best = soldBefore + (room - gainBefore) / slope;
      soldBefore += lot.qty;
      gainBefore = gainAll;
    }
    return wholeShares(position) ? Math.floor(best + 1e-9) : Math.floor(best * 1e4) / 1e4;
  }

  function taxAvailable(key, sims = state.taxSims) {
    return remainingLots(key, sims).reduce((s, lot) => s + lot.qty, 0);
  }

  function roundSimQty(position, qty) {
    return wholeShares(position) ? Math.floor(qty + 1e-9) : Math.floor(qty * 1e4 + 1e-6) / 1e4;
  }

  function draftTaxSim() {
    const position = taxPosition(state.taxSimKey);
    if (!position || position.price_eur == null) return null;
    const qty = Math.min(state.taxDraftQty || 0, taxAvailable(position.key));
    return qty > 0 ? { key: position.key, qty } : null;
  }

  // €860 · €9.6k · €60.3k
  function formatShortEur(value) {
    const amount = Math.abs(value);
    if (amount < 1000) return `€${Math.round(amount).toLocaleString('en-US')}`;
    const [divisor, suffix] = amount >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
    return `€${(amount / divisor).toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`;
  }

  function formatBasis(piece) {
    const perShare = piece.qty ? piece.basis_eur / piece.qty : 0;
    return `€${perShare.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  }

  function taxPieceRow(piece, _index, pieces) {
    const capped = piece.method === 'historical' && piece.gain_eur === 0;
    const label = TAX_BASIS_LABELS[piece.method].replace(/^./, (c) => c.toUpperCase());
    return `
      <div class="settings-row settings-row-static tax-row">
        <span><strong>${formatShareCount(piece.qty)} · bought ${formatDay(piece.acquired)}</strong><small>Basis ${formatBasis(piece)} · ${escapeHtml(label)}${capped ? ', gain capped at €0' : ''}</small></span>
        ${pieces.length > 1 ? `<span class="tax-num ${numberClass(piece.gain_eur)}">${formatSignedEur(piece.gain_eur)}</span>` : '<span></span>'}
      </div>`;
  }

  function renderTaxYearButtons(years) {
    const seg = $('tax-year');
    seg.hidden = years.length < 2;
    seg.innerHTML = years.map((y) => `<button type="button" data-tax-year="${y}" class="${y === state.taxYear ? 'active' : ''}">${y}</button>`).join('');
    syncSegIndicator(seg);
  }

  function renderTaxSummary(year, realised, withPlan, hasPlan) {
    const { rules } = state.capitalGains;
    const shown = hasPlan ? withPlan : realised;
    const exemption = shown.exemption.amount;
    const share = (value) => Math.min(100, Math.max(0, (value / exemption) * 100));
    const real = share(Math.max(0, realised.net));
    const planned = Math.max(0, share(Math.max(0, withPlan.net)) - real);
    const due = shown.tax > 0.005;
    const status = due
      ? `<span class="tax-status is-due">${formatEur(shown.tax)} tax</span><span class="summary-horizon">on ${formatEur(shown.taxable)} over the exemption</span>`
      : `<span class="tax-status">No tax due</span><span class="summary-horizon">${formatEur(shown.exemptionLeft)} tax-free left</span>`;
    const item = (label, value, cls = '') => `
      <span class="summary-item">
        <span class="summary-item-label">${label}</span>
        <span class="summary-item-figures"><span class="summary-item-value ${cls}">${formatNetHtml(value)}</span></span>
      </span>`;
    $('tax-summary').innerHTML = `
      <div class="summary">
        <div class="summary-main">
          <div class="summary-label">Net result ${year}${hasPlan ? ' · with plan' : ''}</div>
          <div class="summary-value${shown.net < 0 ? ' negative' : ''}" data-num="tax-net" data-format="netHtml" data-value="${shown.net}">${formatNetHtml(shown.net)}</div>
          <div class="summary-change">${status}</div>
        </div>
        <div class="summary-secondary tax-secondary">
          ${item('Realised', realised.net, numberClass(realised.net))}
          ${item(`Tax ${Math.round(rules.rate * 100)}%`, shown.tax)}
        </div>
        <div class="tax-meter${due ? ' is-over' : ''}" role="img" aria-label="${Math.round(share(Math.max(0, shown.net)))}% of the exemption used">
          <span class="tax-meter-real" style="width:${real}%"></span>
          <span class="tax-meter-plan" style="left:${real}%;width:${hasPlan ? planned : 0}%"></span>
        </div>
        <div class="tax-meter-scale"><span>Exemption used</span><span>${formatEur(Math.min(exemption, Math.max(0, shown.net)))} of ${formatCompactEur(exemption)}</span></div>
      </div>`;
    compactHeaders.tax = { value: shown.net, change: null, signed: true };
  }

  function renderTaxBreakdown(realised, withPlan, hasPlan) {
    const { rules } = state.capitalGains;
    const shown = hasPlan ? withPlan : realised;
    const money = (value, signed) => (signed ? formatSignedEur(value) : formatEur(value));
    const row = (label, value, before, { signed = true, sign = '', note = '', cls = '' } = {}) => {
      const changed = hasPlan && Math.abs(value - before) > 0.005;
      return `
        <div class="settings-row settings-row-static tax-row ${cls}">
          <span><strong>${label}</strong>${note ? `<small>${note}</small>` : ''}</span>
          <span class="tax-row-value">
            <span class="tax-num ${signed ? numberClass(value) : ''}">${sign}${money(value, signed)}</span>
            ${changed ? `<small>was ${sign}${money(before, signed)}</small>` : ''}
          </span>
        </div>`;
    };
    const carry = shown.exemption.carry;
    $('tax-breakdown').innerHTML = `
      ${row('Gains on sales', shown.gains, realised.gains)}
      ${row('Losses on sales', shown.losses, realised.losses, { note: 'Offset against gains of the same year' })}
      ${shown.adjustment ? row('Other brokers', shown.adjustment, realised.adjustment) : ''}
      ${row('Net result', shown.net, realised.net, { cls: 'is-total' })}
      ${row('Exemption', shown.exemption.amount, realised.exemption.amount, { signed: false, sign: '−', note: carry ? `${formatCompactEur(rules.exemption)} + ${formatCompactEur(carry)} carried over` : 'Per person, per year' })}
      ${row('Taxable', shown.taxable, realised.taxable, { signed: false })}
      ${row(`Tax at ${Math.round(rules.rate * 100)}%`, shown.tax, realised.tax, { signed: false, cls: `is-total${shown.tax > 0.005 ? ' is-due' : ''}` })}`;
  }

  function taxListRow({ name, meta, value, valueCls = '', sub = '', attrs = '', trailing = '', cls = '' }) {
    return `
      <div class="tax-list-row ${cls}" ${attrs}>
        <div class="with-avatar">
          ${positionAvatar(name)}
          <div class="with-avatar-text">
            <div class="holding-name" title="${escapeHtml(name)}">${escapeHtml(positionTitle(name))}</div>
            <div class="holding-meta">${meta}</div>
          </div>
        </div>
        <div class="tax-list-value">
          <div class="value-main tax-num ${valueCls}">${value}</div>
          ${sub ? `<span class="holding-shares">${sub}</span>` : ''}
        </div>
        ${trailing}
      </div>`;
  }

  function renderTaxSales(year) {
    const sales = state.capitalGains.sales.filter((s) => s.year === year);
    $('tax-sales-title').textContent = `Sales in ${year}`;
    const warnings = (state.capitalGains.warnings || []).map((w) => `<p class="tax-warning">${escapeHtml(w)}</p>`).join('');
    $('tax-sales').innerHTML = warnings + (sales.length
      ? sales.map((sale) => taxListRow({
        name: sale.name,
        meta: `${formatDay(sale.date)} · ${formatShareCount(sale.quantity)}`,
        value: formatSignedEur(sale.gain_eur),
        valueCls: numberClass(sale.gain_eur),
        sub: `sold ${formatShortEur(sale.proceeds_eur)}`,
        attrs: `data-tax-sale="${state.capitalGains.sales.indexOf(sale)}" role="button" tabindex="0"`,
        cls: 'is-clickable',
      })).join('')
      : `<div class="muted-empty">No DEGIRO sales in ${year}.</div>`);
  }

  function renderTaxPlan() {
    const isCurrent = state.taxYear === currentTaxYear();
    const simulated = isCurrent ? simulateTaxSales(state.taxSims, state.taxYear) : [];
    $('tax-plan-panel').hidden = !simulated.length;
    $('tax-plan').innerHTML = simulated.map((sim, i) => taxListRow({
      name: sim.position?.name || sim.key,
      meta: `Sell ${formatShareCount(sim.qty)} · ${formatShortEur(sim.proceeds_eur)}`,
      value: formatSignedEur(sim.gain_eur),
      valueCls: numberClass(sim.gain_eur),
      cls: i === state.taxPlanEnter ? 'is-entering' : '',
      attrs: `data-tax-plan-row="${i}"`,
      trailing: `<button class="btn btn-ghost btn-icon tax-plan-remove" type="button" data-tax-sim-remove="${i}" aria-label="Remove from plan">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>`,
    })).join('');
    state.taxPlanEnter = -1;
    $('tax-open-sim').hidden = !isCurrent;
    $('tax-open-sim-meta').textContent = simulated.length
      ? `${simulated.length} planned ${simulated.length === 1 ? 'sale' : 'sales'} · add another`
      : 'See the tax before you sell';
  }

  function renderTaxRules() {
    const { rules } = state.capitalGains;
    const pct = Math.round(rules.rate * 100);
    $('tax-rules-list').innerHTML = [
      `${pct}% on the net result of sales from ${formatDay(rules.start)}. Unrealised gains are not taxed.`,
      `The first ${formatCompactEur(rules.exemption)} of net gains per person per year are exempt. An unused exemption adds up to ${formatCompactEur(rules.exemptionCarryPerYear)} to the next year, up to ${formatCompactEur(rules.exemptionMax)}.`,
      `Shares bought before ${formatDay(rules.start)} use their price on ${formatDay(rules.photoDate)} as purchase value. Until ${rules.historicalUntilYear} a higher original purchase price may be used instead; it can bring a gain down to €0 but never creates a loss.`,
      'Losses are offset against gains of the same year only; they do not carry over.',
      'Gross prices: fees and TOB do not lower the gain. Shares leave oldest first (FIFO).',
      'DEGIRO withholds nothing: a gain above the exemption is declared in your tax return.',
      'An estimate from the data in this app, not tax advice.',
    ].map((text) => `<li>${escapeHtml(text)}</li>`).join('');
  }

  function renderTaxSale(index) {
    const sale = state.capitalGains.sales[index];
    if (!sale) return;
    $('tax-sale-title').textContent = positionTitle(sale.name);
    $('tax-sale-body').innerHTML = `
      <div class="summary tax-sale-summary">
        <div class="summary-main">
          <div class="summary-label">${formatDay(sale.date)} · ${formatShareCount(sale.quantity)} @ ${formatPrice(sale.price, sale.currency)}</div>
          <div class="summary-value ${numberClass(sale.gain_eur)}">${formatSignedEur(sale.gain_eur)}</div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-row settings-row-static tax-row"><span><strong>Sold for</strong><small>Gross, before fees</small></span><span class="tax-num">${formatEur(sale.proceeds_eur)}</span></div>
        <div class="settings-row settings-row-static tax-row"><span><strong>Tax basis</strong><small>Oldest shares first</small></span><span class="tax-num">−${formatEur(sale.basis_eur)}</span></div>
        <div class="settings-row settings-row-static tax-row is-total"><span><strong>Result</strong></span><span class="tax-num ${numberClass(sale.gain_eur)}">${formatSignedEur(sale.gain_eur)}</span></div>
      </div>
      <section class="settings-section">
        <div class="settings-kicker">Shares sold, by purchase</div>
        <div class="settings-group">${sale.pieces.map(taxPieceRow).join('')}</div>
      </section>`;
  }

  // ── Simulate flow: pick a position, then an amount. ──
  function renderTaxPositions() {
    const year = state.taxYear;
    const positions = state.capitalGains.positions.filter((p) => p.price_eur != null);
    $('tax-sim-positions').innerHTML = positions.length ? positions.map((p) => {
      const left = taxAvailable(p.key);
      const free = left > 1e-8 ? Math.min(left, taxFreeQty(p.key, state.taxSims, year)) : 0;
      const hint = left <= 1e-8 ? 'All in your plan'
        : free >= left - 1e-8 ? 'All tax-free' : `${formatShares(free)} tax-free`;
      return `
        <button class="settings-row tax-pick-row" type="button" data-tax-key="${p.key}"${left <= 1e-8 ? ' disabled' : ''}>
          ${positionAvatar(p.name)}
          <span><strong>${escapeHtml(positionTitle(p.name))}</strong><small>${formatShares(roundSimQty(p, left))} shares · ${formatShortEur(left * p.price_eur)}${p.broker ? ` · ${escapeHtml(p.broker)}` : ''}</small></span>
          <span class="tax-pick-hint${free > 0 ? ' is-free' : ''}">${hint}</span>
        </button>`;
    }).join('') : '<div class="muted-empty">No open positions with a price.</div>';
  }

  function showTaxStep(step, { back = false } = {}) {
    const pick = step === 'pick';
    const target = $(pick ? 'tax-step-pick' : 'tax-step-amount');
    $('tax-step-pick').hidden = !pick;
    $('tax-step-amount').hidden = pick;
    $('tax-sim-back').hidden = pick;
    const position = taxPosition(state.taxSimKey);
    $('tax-sim-title').textContent = pick || !position ? 'Simulate a sale' : positionTitle(position.name);
    target.classList.remove('step-in-forward', 'step-in-back');
    void target.offsetWidth;
    target.classList.add(back ? 'step-in-back' : 'step-in-forward');
    if (!pick) {
      requestAnimationFrame(() => syncSegIndicator($('tax-sim-mode')));
      updateTaxSim();
    }
  }

  function openTaxSim() {
    if (!state.capitalGains) return;
    state.taxDraftQty = 0;
    $('tax-sim-amount').value = '';
    renderTaxPositions();
    showTaxStep('pick');
    openOverlay('tax-sim-overlay');
  }

  function syncTaxAmountInput() {
    const position = taxPosition(state.taxSimKey);
    const eur = state.taxSimMode === 'eur';
    $('tax-qty-prefix').hidden = !eur;
    $('tax-qty-unit').textContent = eur ? '' : (Math.abs(state.taxDraftQty - 1) < 1e-8 ? 'share' : 'shares');
    const input = $('tax-sim-amount');
    if (document.activeElement !== input) {
      if (!state.taxDraftQty || !position) input.value = '';
      else input.value = eur ? (state.taxDraftQty * position.price_eur).toFixed(2) : String(state.taxDraftQty);
    }
    input.style.width = `${Math.max(1, (input.value || input.placeholder).length) + 0.4}ch`;
    $('tax-sim-mode').querySelectorAll('[data-sim-mode]').forEach((btn) => btn.classList.toggle('active', btn.dataset.simMode === state.taxSimMode));
    syncSegIndicator($('tax-sim-mode'));
  }

  function updateTaxSim({ instant = false } = {}) {
    const year = state.taxYear;
    const position = taxPosition(state.taxSimKey);
    if (!position) return;
    const available = taxAvailable(position.key);
    const max = wholeShares(position) ? Math.floor(available + 1e-9) : available;
    const freeQty = Math.min(max, taxFreeQty(position.key, state.taxSims, year));
    state.taxFreeQty = freeQty;
    const range = $('tax-sim-range');
    range.max = String(max || 1);
    range.step = wholeShares(position) ? '1' : 'any';
    if (Number(range.value) !== state.taxDraftQty) range.value = String(state.taxDraftQty);
    const pct = (q) => (max > 0 ? Math.min(100, (q / max) * 100) : 0);
    const slider = $('tax-slider');
    slider.style.setProperty('--fill', `${pct(state.taxDraftQty)}%`);
    slider.style.setProperty('--free', `${pct(freeQty)}%`);
    slider.style.setProperty('--split', `${state.taxDraftQty > 0 ? Math.min(100, (freeQty / state.taxDraftQty) * 100) : 100}%`);
    slider.classList.toggle('is-over', state.taxDraftQty > freeQty + 1e-9);
    $('tax-slider-mark').hidden = !(freeQty > 0 && freeQty < max);
    $('tax-slider-max').textContent = formatShares(max);
    $('tax-slider-free-label').textContent = freeQty >= max - 1e-9 ? 'All tax-free' : freeQty > 0 ? `Tax-free up to ${formatShares(freeQty)}` : 'No tax-free room left';

    const quick = [
      ['25%', roundSimQty(position, max * 0.25)],
      ['50%', roundSimQty(position, max * 0.5)],
      ...(freeQty > 0 && freeQty < max ? [['Tax-free', freeQty]] : []),
      ['All', max],
    ];
    $('tax-quick').innerHTML = quick.map(([label, qty]) => `<button type="button" data-tax-qty="${qty}" class="${qty > 0 && Math.abs(qty - state.taxDraftQty) < 1e-8 ? 'active' : ''}">${label}</button>`).join('');
    syncSegIndicator($('tax-quick'));

    const draft = draftTaxSim();
    const before = taxTotals(year, simulateTaxSales(state.taxSims, year));
    const simulated = draft ? simulateTaxSales([...state.taxSims, draft], year) : [];
    const sim = simulated[simulated.length - 1];
    const after = draft ? taxTotals(year, simulated) : before;
    const due = after.tax - before.tax > 0.005;
    const row = (label, value, note = '') => `<div class="settings-row settings-row-static tax-row"><span><strong>${label}</strong>${note ? `<small>${note}</small>` : ''}</span>${value}</div>`;
    $('tax-sim-result').innerHTML = [
      row('Proceeds', `<span class="tax-num" data-num="tax-sim-proceeds" data-format="eur" data-value="${sim?.proceeds_eur || 0}">${formatEur(sim?.proceeds_eur || 0)}</span>`, `@ ${formatPrice(position.price_eur, 'EUR')}`),
      row('Capital gain', `<span class="tax-num ${numberClass(sim?.gain_eur || 0)}" data-num="tax-sim-gain" data-format="signedEur" data-value="${sim?.gain_eur || 0}">${formatSignedEur(sim?.gain_eur || 0)}</span>`),
      row('Tax this year', `<span class="tax-num tax-before-after">${draft && due ? `<s>${formatEur(before.tax)}</s>` : ''}<span class="${due ? 'tax-status is-due' : ''}" data-num="tax-sim-tax" data-format="eur" data-value="${after.tax}">${formatEur(after.tax)}</span></span>`, draft ? (due ? `+${formatEur(after.tax - before.tax)} from this sale` : `${formatEur(after.exemptionLeft)} tax-free left after`) : `${formatEur(before.exemptionLeft)} tax-free left`),
    ].join('');
    const lots = sim?.pieces || [];
    $('tax-sim-basis').textContent = lots.length
      ? `Basis ${lots.map((p) => `${formatBasis(p)} (${TAX_BASIS_LABELS[p.method]}) for ${formatShareCount(p.qty)} bought ${formatDay(p.acquired)}`).join('; ')}.`
      : '';
    $('tax-sim-add').disabled = !draft;
    $('tax-sim-add').textContent = draft ? `Add to plan · ${formatShareCount(draft.qty)}` : 'Add to plan';
    syncTaxAmountInput();
    animateNumbers($('tax-sim-result'), { instant });
  }

  function setTaxDraftQty(qty, { from = '' } = {}) {
    const position = taxPosition(state.taxSimKey);
    if (!position) return;
    const max = taxAvailable(position.key);
    const next = Math.max(0, Math.min(max, roundSimQty(position, qty)));
    const crossed = (state.taxDraftQty <= state.taxFreeQty) !== (next <= state.taxFreeQty);
    state.taxDraftQty = next;
    if (from === 'range' && crossed) navigator.vibrate?.(8);
    updateTaxSim({ instant: from === 'range' || from === 'input' });
  }

  function updateTaxResults() {
    const data = state.capitalGains;
    if (!data) return;
    const year = state.taxYear;
    const plan = year === currentTaxYear() ? simulateTaxSales(state.taxSims, year) : [];
    const realised = taxTotals(year);
    const withPlan = taxTotals(year, plan);
    renderTaxSummary(year, realised, withPlan, plan.length > 0);
    renderTaxBreakdown(realised, withPlan, plan.length > 0);
    renderTaxPlan();
    animateNumbers($('tax-summary'));
    updateCompactHeader();
  }

  function renderTax() {
    const data = state.capitalGains;
    if (!data) {
      $('tax-summary').innerHTML = '<div class="muted-empty">Capital gains appear once transactions are imported.</div>';
      return;
    }
    const years = taxYears();
    if (!years.includes(state.taxYear)) state.taxYear = years.includes(currentTaxYear()) ? currentTaxYear() : years[years.length - 1];
    $('tax-summary-title').textContent = `Capital gains ${state.taxYear}`;
    if (document.activeElement !== $('tax-adjust')) $('tax-adjust').value = taxAdjustment(state.taxYear) || '';
    state.taxSims = state.taxSims.filter((sim) => taxPosition(sim.key));
    renderTaxYearButtons(years);
    renderTaxRules();
    renderTaxSales(state.taxYear);
    updateTaxResults();
  }

  function saveTaxSims() {
    writeStored(TAX_SIMS_KEY, state.taxSims);
  }

  async function loadCapitalGains({ fromCache = false } = {}) {
    try {
      const url = '/api/capital-gains';
      const data = fromCache ? readCache(url) : await fetchJson(url);
      if (!data?.rules) return;
      state.capitalGains = data;
      renderTax();
    } catch (err) {
      console.error('Failed to load capital gains', err);
    }
  }

  const TAX_OVERLAYS = ['tax-sim-overlay', 'tax-calc-overlay', 'tax-sale-overlay'];

  function bindTaxEvents() {
    const storedSims = readStored(TAX_SIMS_KEY, []);
    state.taxSims = Array.isArray(storedSims) ? storedSims.filter((sim) => sim?.key && sim.qty > 0) : [];
    state.taxSimMode = readStored('taxSimMode', 'shares') === 'eur' ? 'eur' : 'shares';

    TAX_OVERLAYS.forEach((id) => $(id).addEventListener('click', (e) => {
      if (e.target === $(id) || e.target.closest('[data-close-tax]')) closeOverlay(id);
    }));
    $('tax-year').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tax-year]');
      if (!btn) return;
      state.taxYear = Number(btn.dataset.taxYear);
      renderTax();
    });
    $('tax-open-sim').addEventListener('click', openTaxSim);
    $('tax-open-calc').addEventListener('click', () => openOverlay('tax-calc-overlay'));
    const openSale = (row) => {
      renderTaxSale(Number(row.dataset.taxSale));
      openOverlay('tax-sale-overlay');
    };
    $('tax-sales').addEventListener('click', (e) => {
      const row = e.target.closest('[data-tax-sale]');
      if (row) openSale(row);
    });
    $('tax-sales').addEventListener('keydown', (e) => {
      const row = e.target.closest('[data-tax-sale]');
      if (row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openSale(row);
      }
    });
    $('tax-sim-positions').addEventListener('click', (e) => {
      const row = e.target.closest('[data-tax-key]');
      if (!row || row.disabled) return;
      state.taxSimKey = row.dataset.taxKey;
      state.taxDraftQty = 0;
      $('tax-sim-amount').value = '';
      showTaxStep('amount');
    });
    $('tax-sim-back').addEventListener('click', () => {
      renderTaxPositions();
      showTaxStep('pick', { back: true });
    });
    $('tax-sim-mode').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sim-mode]');
      if (!btn || btn.dataset.simMode === state.taxSimMode) return;
      state.taxSimMode = btn.dataset.simMode;
      writeStored('taxSimMode', state.taxSimMode);
      $('tax-sim-amount').blur();
      syncTaxAmountInput();
    });
    $('tax-sim-range').addEventListener('input', () => {
      $('tax-sim-amount').blur();
      setTaxDraftQty(Number($('tax-sim-range').value), { from: 'range' });
    });
    $('tax-sim-amount').addEventListener('input', () => {
      const position = taxPosition(state.taxSimKey);
      const amount = Number($('tax-sim-amount').value) || 0;
      if (!position?.price_eur) return;
      setTaxDraftQty(state.taxSimMode === 'eur' ? amount / position.price_eur : amount, { from: 'input' });
    });
    $('tax-sim-amount').addEventListener('blur', syncTaxAmountInput);
    $('tax-sim-amount').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('tax-sim-add').click();
    });
    $('tax-quick').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tax-qty]');
      if (!btn) return;
      $('tax-sim-amount').blur();
      setTaxDraftQty(Number(btn.dataset.taxQty));
    });
    $('tax-sim-add').addEventListener('click', () => {
      const draft = draftTaxSim();
      if (!draft) return;
      state.taxSims.push(draft);
      state.taxPlanEnter = state.taxSims.length - 1;
      state.taxDraftQty = 0;
      saveTaxSims();
      closeOverlay('tax-sim-overlay');
      updateTaxResults();
    });
    $('tax-plan-clear').addEventListener('click', () => {
      $('tax-plan').querySelectorAll('.tax-list-row').forEach((row) => row.classList.add('is-leaving'));
      setTimeout(() => {
        state.taxSims = [];
        saveTaxSims();
        updateTaxResults();
      }, 200);
    });
    $('tax-plan').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tax-sim-remove]');
      if (!btn) return;
      btn.closest('.tax-list-row').classList.add('is-leaving');
      setTimeout(() => {
        state.taxSims.splice(Number(btn.dataset.taxSimRemove), 1);
        saveTaxSims();
        updateTaxResults();
      }, 200);
    });
    $('tax-adjust').addEventListener('input', () => {
      const all = readStored(TAX_ADJUST_KEY, {});
      const value = Number($('tax-adjust').value);
      if (value) all[state.taxYear] = value;
      else delete all[state.taxYear];
      writeStored(TAX_ADJUST_KEY, all);
      updateTaxResults();
    });
  }

  function setSidebarOpen(open) {
    $('sidebar').classList.toggle('open', open);
    const backdrop = $('sidebar-backdrop');
    if (backdrop) backdrop.hidden = !open;
  }

  function setMobileMoreOpen(open) {
    const menu = $('mobile-more');
    const button = $('mobile-more-btn');
    if (!menu || !button) return;
    clearTimeout(Number(menu.dataset.closeTimer));
    if (open) {
      menu.hidden = false;
      menu.classList.remove('is-closing');
    } else if (!menu.hidden && !menu.classList.contains('is-closing')) {
      menu.classList.add('is-closing');
      const timer = setTimeout(() => {
        menu.hidden = true;
        menu.classList.remove('is-closing');
        delete menu.dataset.closeTimer;
      }, 190);
      menu.dataset.closeTimer = String(timer);
    }
    menu.setAttribute('aria-hidden', String(!open));
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-open', open);
    document.body.classList.toggle('mobile-more-open', open);
    if (open) {
      requestAnimationFrame(() => menu.querySelector('.mobile-more-item:not([hidden])')?.focus({ preventScroll: true }));
    }
  }

  function bindTouchFeedback() {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    document.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      const target = event.target.closest('.btn, .mobile-tab, .mobile-more-item, .holding-row.is-clickable, .tt-holding-row.is-clickable, [data-perf-select], [data-lot-id], .seg button');
      if (!target || target.matches(':disabled')) return;
      const rect = target.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'tap-ripple';
      ripple.style.left = `${event.clientX - rect.left}px`;
      ripple.style.top = `${event.clientY - rect.top}px`;
      target.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    }, { passive: true });
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item[data-view], .mobile-tab[data-view], .mobile-more-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    $('menu-btn').addEventListener('click', () => {
      setSidebarOpen(!$('sidebar').classList.contains('open'));
    });
    $('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
    $('mobile-more-btn').addEventListener('click', () => setMobileMoreOpen($('mobile-more').hidden));
    $('mobile-more-backdrop').addEventListener('click', () => setMobileMoreOpen(false));
    $('theme-mode').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-mode]');
      if (btn) setThemeMode(btn.dataset.themeMode);
    });
    $('settings-btn').addEventListener('click', openSettings);
    $('mobile-settings-btn').addEventListener('click', () => {
      setMobileMoreOpen(false);
      openSettings();
    });
    $('settings-close').addEventListener('click', () => closeOverlay('settings-overlay'));
    $('settings-overlay').addEventListener('click', (e) => {
      if (e.target === $('settings-overlay')) closeOverlay('settings-overlay');
    });
    $('gmail-save-credentials').addEventListener('click', saveGmailCredentials);
    $('mail-imports').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-undo-import]');
      if (btn) undoMailImport(Number(btn.dataset.undoImport), Number(btn.dataset.count));
    });
    document.querySelectorAll('[data-mail-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyMailboxPreset(btn.dataset.mailPreset));
    });
    $('gmail-scan-btn').addEventListener('click', () => scanGmailConfirmations());
    $('sidebar-scan-btn').addEventListener('click', () => scanGmailConfirmations());
    $('mobile-scan-btn').addEventListener('click', () => {
      setMobileMoreOpen(false);
      scanGmailConfirmations();
    });
    $('gmail-disconnect-btn').addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/gmail/disconnect', { method: 'POST' });
        const result = await resp.json();
        showToast(result.message || 'Mailbox disconnected', result.success);
        if (result.success) await loadGmailStatus();
      } catch (err) {
        showToast(`Disconnect failed: ${err.message}`, false);
      }
    });
    $('live-refresh-btn').addEventListener('click', () => refreshLivePrices(true));
    $('include-other-brokers').addEventListener('change', async (e) => {
      state.includeOtherBrokers = e.target.checked;
      localStorage.setItem('includeOtherBrokers', String(state.includeOtherBrokers));
      await Promise.all([
        loadPortfolioSummary(),
        loadPortfolioValuationChart(),
        loadHoldings(),
        loadPerformance(),
      ]);
    });
    $('chart-range-selector').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      setGraphWindow(btn.dataset.range, 0);
    });
    $('lot-range-selector').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      state.selectedPerfRange = btn.dataset.range;
      renderLotRangeButtons();
      lotChart.hoverIndex = null;
      startChartReveal(lotChart);
      lotChart.draw();
    });
    $('perf-expand-btn').addEventListener('click', () => {
      if (state.perfOverlayOpen) closePerformanceOverlay();
      else setPerfExpanded(!state.perfDetailExpanded);
    });
    $('performance-overlay').addEventListener('click', (e) => {
      if (e.target === $('performance-overlay')) closePerformanceOverlay();
    });
    window.addEventListener('popstate', () => {
      if (state.perfOverlayOpen) closePerformanceOverlay({ fromHistory: true });
    });
    window.matchMedia('(max-width: 860px)').addEventListener('change', (e) => {
      if (state.perfOverlayOpen) {
        requestAnimationFrame(() => lotChart.draw());
        return;
      }
      if (e.matches && (state.selectedHoldingKey || state.selectedLotId)) {
        setPerfExpanded(true);
      } else if (!e.matches) {
        setPerfExpanded(false);
      }
    });
    $('chart-scale-btn').addEventListener('click', () => {
      state.chartAutoScale = !state.chartAutoScale;
      updateScaleButton();
      startChartReveal(valuationChart);
      applyChartRange();
    });
    $('tt-prev').addEventListener('click', () => shiftGraphPeriod(-1));
    $('tt-next').addEventListener('click', () => shiftGraphPeriod(1));
    $('tt-date').addEventListener('change', () => jumpToGraphDate($('tt-date').value));
    $('tt-date').addEventListener('click', () => {
      try { $('tt-date').showPicker?.(); } catch { /* picker opens natively */ }
    });
    $('tt-content').addEventListener('click', (e) => {
      const holding = e.target.closest('[data-perf-key]');
      if (holding) {
        openHoldingPerformance(holding.dataset.perfKey, holding);
      }
    });
    $('file-input').addEventListener('change', () => uploadFile($('file-input'), '/api/upload-transactions', 'Uploading transactions…'));
    const clickUploadTx = () => { closeOverlay('settings-overlay'); $('file-input').click(); };
    $('upload-tx-btn').addEventListener('click', clickUploadTx);
    $('empty-upload-tx').addEventListener('click', clickUploadTx);
    $('update-market-btn').addEventListener('click', updateMarketData);
    $('purge-btn').addEventListener('click', () => {
      closeOverlay('settings-overlay');
      openConfirm('Purge all data', 'This deletes stocks, transactions, prices, cash movements, and manual holdings.', 'Delete everything', purgeDatabase);
    });
    $('add-holding-btn').addEventListener('click', openManualModal);
    $('manual-overlay').addEventListener('click', (e) => {
      if (e.target === $('manual-overlay') || e.target.closest('[data-close-manual]')) closeOverlay('manual-overlay');
      if (e.target.matches('input[name="mh-price-mode"]')) {
        $('mh-price-label').textContent = e.target.value === 'total' ? 'Total amount (€)' : 'Price per share (€)';
      }
      if (e.target.id === 'mh-submit') submitManualHolding();
    });
    $('confirm-overlay').addEventListener('click', (e) => {
      if (e.target === $('confirm-overlay') || e.target.closest('[data-close-confirm]')) closeOverlay('confirm-overlay');
    });
    $('scan-overlay').addEventListener('click', (e) => {
      if (e.target === $('scan-overlay') || e.target.closest('[data-close-scan]')) closeOverlay('scan-overlay');
    });
    $('other-brokers-content').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-delete-holding]');
      if (!btn) return;
      openConfirm('Delete holding', 'Remove this other-broker holding?', 'Delete', () => deleteManualHolding(btn.dataset.deleteHolding));
    });
    document.querySelectorAll('.change-mode').forEach((seg) => seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (btn) setChangeMode(btn.dataset.mode);
    }));
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-toggle-change-mode]')) setChangeMode(state.holdingChangeMode === 'eur' ? 'pct' : 'eur');
    });
    $('holdings-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-perf-key]');
      if (!row) return;
      openHoldingPerformance(row.dataset.perfKey, row);
    });
    $('perf-holdings').addEventListener('click', (e) => {
      const groupToggle = e.target.closest('[data-perf-group-toggle]');
      if (groupToggle) {
        const group = groupToggle.dataset.perfGroupToggle;
        state.perfGroupCollapsed[group] = state.perfGroupCollapsed[group] !== true;
        renderPerformance();
        return;
      }
      const lotBtn = e.target.closest('[data-lot-id]');
      if (lotBtn) {
        selectLot(lotBtn.dataset.lotId);
        return;
      }
      const toggle = e.target.closest('[data-perf-toggle]');
      if (toggle) {
        togglePerfLots(toggle.dataset.perfToggle);
        return;
      }
      const select = e.target.closest('[data-perf-select]');
      if (select) selectPosition(select.dataset.perfSelect);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('mobile-more').hidden) {
          setMobileMoreOpen(false);
          $('mobile-more-btn').focus({ preventScroll: true });
          return;
        }
        if (state.perfOverlayOpen) {
          closePerformanceOverlay();
          return;
        }
        if ($('sidebar').classList.contains('open')) {
          setSidebarOpen(false);
          return;
        }
        if (state.perfDetailExpanded) {
          setPerfExpanded(false);
          return;
        }
        closeOverlay('settings-overlay');
        closeOverlay('manual-overlay');
        closeOverlay('confirm-overlay');
        closeOverlay('scan-overlay');
        TAX_OVERLAYS.forEach(closeOverlay);
      }
    });
  }

  async function initialize() {
    initTheme();
    bindEvents();
    bindTaxEvents();
    bindTouchFeedback();
    bindSheetDrag();
    renderHoldingChangeMode();
    renderLotRangeButtons();
    setInterval(checkServerStatus, 5000);

    initIncludeOtherBrokers();
    const [cachedSummary, cachedChart] = await Promise.all([
      loadPortfolioSummary({ fromCache: true }),
      loadPortfolioValuationChart({ fromCache: true }),
      loadHoldings({ fromCache: true }),
      loadPerformance({ fromCache: true }),
      loadCapitalGains({ fromCache: true }),
    ]);
    const hydrated = Boolean(cachedSummary || cachedChart);
    if (hydrated) {
      state.hasData = true;
      updateEmptyState();
      setLoading('', false);
    }

    const online = await checkServerStatus();
    if (!online) {
      setLoading('', false);
      return;
    }

    await fetchServerConfig();
    initIncludeOtherBrokers();
    await loadUserPreferences();
    if (!hydrated) setLoading('Loading holdings, summary, and history…', true);

    const [summary, chartOk] = await Promise.all([
      loadPortfolioSummary(),
      loadPortfolioValuationChart(),
      loadHoldings(),
      loadPerformance(),
      loadOtherBrokersPanel(),
      loadGmailStatus(),
      loadCapitalGains(),
    ]);

    state.hasData = Boolean(
      (summary && (summary.total_holdings > 0 || summary.current_value > 0))
      || chartOk
      || state.holdings.length
    );
    updateEmptyState();
    setLoading('', false);

    await refreshLivePrices(false);
    if (state.livePricesInterval) clearInterval(state.livePricesInterval);
    state.livePricesInterval = setInterval(() => refreshLivePrices(false), 60 * 60 * 1000);
  }

  initialize();
})();
