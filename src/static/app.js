(() => {
  const VIEW_META = {
    overview: { title: 'Overview', subtitle: 'Live value, invested capital, and P/L' },
    graph: { title: 'Graph', subtitle: 'Portfolio value and holdings on a selected date' },
    performance: { title: 'Performance', subtitle: 'Return per tracker and per purchase' },
    history: { title: 'History', subtitle: 'Month-end value and gain / loss' },
    brokers: { title: 'Other brokers', subtitle: 'Manual holdings outside DEGIRO' },
  };

  const TRACKER_KEYWORDS = ['ETF', 'UCITS', 'Tracker', 'iShares', 'Vanguard', 'SPDR', 'Amundi', 'Xtrackers', 'Lyxor'];

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
    ttSectionStates: { 'tt-stocks': false, 'tt-trackers': false, 'tt-other-brokers': false },
    performanceHoldings: [],
    perfCollapsed: {},
    selectedLotId: null,
    selectedHoldingKey: null,
    selectedPerfRange: 'MAX',
    perfDetailExpanded: false,
    lotChartData: null,
    serverConfig: null,
    latestPortfolioSummary: null,
    latestPortfolioHistoryData: null,
    portfolioHistoryDates: [],
    selectedHistoryDate: null,
    ttMinDate: null,
    ttMaxDate: null,
    exchangeRates: { EUR: 1, USD: null, SEK: null, GBP: null },
    uploadInProgress: false,
    livePricesInterval: null,
    hasData: false,
  };

  const $ = (id) => document.getElementById(id);

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

  function formatPct(value) {
    const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${prefix}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }

  function metricChangeHtml(eur, pct, { horizon } = {}) {
    if (eur == null || pct == null || Number.isNaN(eur) || Number.isNaN(pct)) return '';
    const horizonHtml = horizon ? `<span class="stat-horizon">${horizon}</span>` : '';
    return `<div class="stat-sub ${numberClass(eur)}">${horizonHtml}<span class="stat-pnl">${formatSignedEur(eur)}</span><span class="stat-pct">${formatPct(pct)}</span></div>`;
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

  function formatShares(n) {
    if (n == null) return '—';
    if (Number.isInteger(n)) return String(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
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
    row.style.display = visible ? 'flex' : 'none';
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
    };
  }

  const valuationChart = {
    canvas: null,
    ctx: null,
    wrap: null,
    tooltip: null,
    hoverIndex: null,
    bound: false,
    pad: { top: 12, right: 12, bottom: 26, left: 52 },

    init() {
      this.canvas = $('valuation-canvas');
      this.wrap = $('chart-canvas-wrap');
      this.tooltip = $('chart-tooltip');
      if (!this.canvas || !this.wrap) return;
      this.ctx = this.canvas.getContext('2d');
      if (this.bound) return;
      this.bound = true;

      const onMove = (e) => this.onPointer(e);
      this.canvas.addEventListener('pointermove', onMove);
      this.canvas.addEventListener('pointerdown', (e) => {
        const idx = this.indexFromEvent(e);
        if (idx == null) return;
        const slice = this.visibleSlice();
        const date = slice.dates[idx];
        if (date) syncHistoryDate(date, 'chart');
      });
      this.canvas.addEventListener('pointerleave', () => {
        this.hoverIndex = null;
        this.tooltip.hidden = true;
        this.draw();
      });
      new ResizeObserver(() => this.draw()).observe(this.wrap);
    },

    visibleSlice() {
      const data = state.latestPortfolioHistoryData;
      if (!data?.dates?.length) return null;
      const [start, end] = getChartRangeBounds(state.selectedChartRange, data.dates);
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
        ? { top: 8, right: 4, bottom: 22, left: 36 }
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

      const range = this.yRange(slice);
      const colors = chartColors();
      const n = slice.dates.length;
      const { pad } = this;

      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.text;
      ctx.font = `${window.matchMedia('(max-width: 860px)').matches ? 10 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const tick of this.niceTicks(range.min, range.max)) {
        const y = this.yOf(tick, range, plotH);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        const label = tick >= 1000
          ? `€${Math.round(tick / 1000)}k`
          : `€${Math.round(tick)}`;
        ctx.fillText(label, pad.left - 8, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = axisTickDates(slice.dates);
      const seen = new Set();
      for (const date of xTicks) {
        const label = formatAxisDate(date);
        if (seen.has(label) && date !== xTicks[0] && date !== xTicks[xTicks.length - 1]) continue;
        seen.add(label);
        ctx.fillText(label, xOfTime(date, slice.dates, pad.left, plotW), pad.top + plotH + 8);
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

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (slice.values[i] == null) continue;
        const x = this.xOf(i, slice.dates, plotW);
        const y = this.yOf(slice.values[i], range, plotH);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      const lastX = this.xOf(n - 1, slice.dates, plotW);
      const baseY = this.yOf(Math.max(0, range.min), range, plotH);
      ctx.lineTo(lastX, baseY);
      ctx.lineTo(this.xOf(0, slice.dates, plotW), baseY);
      ctx.closePath();
      ctx.fillStyle = colors.fill;
      ctx.fill();

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
      pathFor(slice.values);
      ctx.stroke();

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
        ? { top: 8, right: 4, bottom: 22, left: 36 }
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

      const range = this.yRange();
      const colors = chartColors();
      const n = slice.dates.length;
      const { pad } = this;

      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.text;
      ctx.font = `${window.matchMedia('(max-width: 860px)').matches ? 10 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const tick of this.niceTicks(range.min, range.max)) {
        const y = this.yOf(tick, range, plotH);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        const label = tick >= 1000 ? `€${Math.round(tick / 1000)}k` : `€${Math.round(tick)}`;
        ctx.fillText(label, pad.left - 8, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = axisTickDates(slice.dates);
      const seen = new Set();
      for (const date of xTicks) {
        const label = formatAxisDate(date);
        if (seen.has(label) && date !== xTicks[0] && date !== xTicks[xTicks.length - 1]) continue;
        seen.add(label);
        ctx.fillText(label, xOfTime(date, slice.dates, pad.left, plotW), pad.top + plotH + 8);
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

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (slice.values[i] == null) continue;
        const x = this.xOf(i, slice.dates, plotW);
        const y = this.yOf(slice.values[i], range, plotH);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      const lastX = this.xOf(n - 1, slice.dates, plotW);
      const fillBase = slice.costs
        ? (slice.costs[n - 1] ?? range.min)
        : (slice.cost ?? range.min);
      const baseY = this.yOf(Math.max(range.min, Math.min(fillBase, range.max)), range, plotH);
      ctx.lineTo(lastX, baseY);
      ctx.lineTo(this.xOf(0, slice.dates, plotW), baseY);
      ctx.closePath();
      ctx.fillStyle = colors.fill;
      ctx.fill();

      ctx.strokeStyle = colors.value;
      ctx.lineWidth = 2.1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      pathFor(slice.values);
      ctx.stroke();

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

  function initTheme() {
    const saved = localStorage.getItem('degiro-theme');
    let theme = 'light';
    if (saved === 'dark' || saved === 'light') theme = saved;
    else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) theme = 'dark';
    setTheme(theme, false);
  }

  function setTheme(theme, relayout = true) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('degiro-theme', theme);
    const icon = $('theme-icon');
    if (icon) {
      icon.innerHTML = theme === 'dark'
        ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
        : '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>';
    }
    if (relayout) applyThemeToChart();
  }

  function toggleTheme() {
    const dark = document.documentElement.classList.contains('dark');
    setTheme(dark ? 'light' : 'dark');
  }

  function applyThemeToChart() {
    valuationChart.draw();
    lotChart.draw();
  }

  function setView(name) {
    const current = document.querySelector('.view.active')?.id?.replace(/^view-/, '');
    if (current === 'performance' && name !== 'performance') {
      setPerfExpanded(false);
    }
    document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
    document.querySelectorAll('.view').forEach((view) => {
      view.classList.toggle('active', view.id === `view-${name}`);
    });
    const meta = VIEW_META[name];
    if (meta) {
      $('view-title').textContent = meta.title;
      $('view-subtitle').textContent = meta.subtitle;
    }
    setSidebarOpen(false);
    if (name === 'graph') {
      requestAnimationFrame(() => valuationChart.draw());
    }
    if (name === 'performance') {
      requestAnimationFrame(() => lotChart.draw());
    }
  }

  async function checkServerStatus() {
    if (state.uploadInProgress) return true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch('/api/ping', { signal: controller.signal });
      clearTimeout(timeout);
      const ok = resp.ok;
      $('offline-banner').classList.toggle('show', !ok);
      return ok;
    } catch {
      $('offline-banner').classList.add('show');
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
      const resp = await fetch('/api/exchange-rates', { signal: controller.signal });
      clearTimeout(timeout);
      const data = await resp.json();
      if (data?.rates) state.exchangeRates = { ...state.exchangeRates, ...data.rates };
    } catch (err) {
      console.error('Failed to load exchange rates', err);
    }
  }

  function renderSummary(summary) {
    if (!summary) return;
    const brokerNote = summary.other_brokers_count > 0
      ? `<div class="stat-line">Includes ${summary.other_brokers_count} other-broker positions</div>`
      : '';
    const dayChange = holdingsDayChange();
    const day = dayChange
      ? metricChangeHtml(dayChange.eur, dayChange.pct, { horizon: '1d' })
      : '';
    $('overview-hero').innerHTML = `
      <div class="hero-metric">
        <div class="stat-label"><i class="legend-swatch value"></i><span class="stat-label-full">Live portfolio value</span><span class="stat-label-short">Value</span></div>
        <div class="stat-value">${formatEur(summary.current_value)}</div>
        ${day}
      </div>
      <div class="hero-metric">
        <div class="stat-label"><i class="legend-swatch invested"></i><span class="stat-label-full">Net invested</span><span class="stat-label-short">Invested</span></div>
        <div class="stat-value">${formatEur(summary.net_invested)}</div>
        ${metricChangeHtml(summary.gain_loss, summary.gain_loss_percent)}
      </div>
      <div class="hero-metric">
        <div class="stat-label"><i class="legend-swatch open"></i><span class="stat-label-full">Open positions</span><span class="stat-label-short">Open</span></div>
        <div class="stat-value">${formatEur(summary.open_cost)}</div>
        ${metricChangeHtml(summary.open_gain_loss, summary.open_gain_loss_percent)}
      </div>
      ${brokerNote}
    `;
  }

  async function loadPortfolioSummary() {
    try {
      const resp = await fetch(`/api/portfolio-summary${otherBrokersQueryParam()}`);
      const summary = await resp.json();
      state.latestPortfolioSummary = summary;
      renderSummary(summary);
      return summary;
    } catch (err) {
      console.error('Failed to load summary', err);
      await checkServerStatus();
      return null;
    }
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

    list.innerHTML = `
      <div class="holdings-list">
        <div class="holdings-head">
          <span>Position</span>
          <span style="text-align:right">Price</span>
          <span style="text-align:right">Value</span>
        </div>
        ${rows.map(({ stock, valueEur }) => {
          const ticker = stock.yahoo_ticker || stock.symbol || '';
          const change = stock.price_change_pct != null
            ? `<span class="price-change ${numberClass(stock.price_change_pct)}">${stock.price_change_pct >= 0 ? '▲' : '▼'} ${Math.abs(stock.price_change_pct).toFixed(2)}%</span>`
            : '';
          return `
            <div class="holding-row is-clickable" data-perf-key="${stock.is_manual ? 'm' : 's'}-${stock.id}">
              <div class="holding-info">
                <div class="holding-name">${escapeHtml(stock.name)}</div>
                <div class="holding-meta">${escapeHtml(ticker)}${stock.exchange ? ` · ${escapeHtml(stock.exchange)}` : ''}<span class="holding-meta-extra">${change ? ` · ${change}` : ''} · ${stock.shares} sh</span></div>
              </div>
              <div class="holding-price">
                <div class="price-main">${stock.latest_price != null ? formatPrice(stock.latest_price, stock.currency) : '—'}</div>
                ${change}
              </div>
              <div class="holding-value">
                <div class="value-main">${valueEur != null ? formatEur(valueEur) : '—'}</div>
                <span class="holding-shares">${stock.shares} shares</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function loadHoldings() {
    try {
      const [, holdingsResp] = await Promise.all([
        fetchExchangeRates(),
        fetch(`/api/holdings${otherBrokersQueryParam()}`),
      ]);
      const data = await holdingsResp.json();
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

  function availablePerfRanges(dates) {
    if (!dates?.length) return CHART_RANGES.filter((key) => ALWAYS_PERF_RANGES.has(key));
    const first = dates[0];
    return CHART_RANGES.filter((key) => {
      if (ALWAYS_PERF_RANGES.has(key)) return true;
      const [start] = getChartRangeBounds(key, dates);
      return Boolean(start && first < start);
    });
  }

  function renderChartRangeButtons() {
    $('chart-range-selector').innerHTML = CHART_RANGES.map((key) => `
      <button type="button" class="${key === state.selectedChartRange ? 'active' : ''}" data-range="${key}">${key}</button>
    `).join('');
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
  }

  function applyChartRange() {
    valuationChart.draw();
  }

  function updateScaleButton() {
    $('chart-scale-btn').textContent = state.chartAutoScale ? 'Auto scale' : 'From zero';
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

    for (let i = 0; i < sorted.length; i++) {
      const [monthKey, snapshot] = sorted[i];
      const year = monthKey.slice(0, 4);
      let gainLoss = 0;
      let gainLossPct = 0;
      let prevValue = 0;
      if (i > 0) {
        prevValue = sorted[i - 1][1].value;
        gainLoss = snapshot.value - prevValue;
        gainLossPct = prevValue > 0 ? (gainLoss / prevValue) * 100 : 0;
      }
      rows.push({ type: 'month', date: snapshot.date, year, value: snapshot.value, gainLoss, gainLossPct });
      if (!yearTotals.has(year)) yearTotals.set(year, { gainLoss: 0, startValue: i > 0 ? prevValue : snapshot.value, endValue: snapshot.value });
      else yearTotals.get(year).endValue = snapshot.value;
      yearTotals.get(year).gainLoss += gainLoss;
    }

    const result = [];
    let currentYear = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (currentYear !== row.year) {
        const yt = yearTotals.get(row.year);
        result.push({
          type: 'year',
          year: row.year,
          value: yt.endValue,
          gainLoss: yt.gainLoss,
          gainLossPct: yt.startValue > 0 ? (yt.gainLoss / yt.startValue) * 100 : 0,
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
    container.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th class="num">Portfolio value</th>
              <th class="num">Gain / loss</th>
              <th class="num">Gain / loss %</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => {
              if (row.type === 'year') {
                return `<tr class="history-year-row">
                  <td>${row.year} Total</td>
                  <td class="num">${formatEur(row.value)}</td>
                  <td class="num ${numberClass(row.gainLoss)}">${formatSignedEur(row.gainLoss)}</td>
                  <td class="num ${numberClass(row.gainLossPct)}">${formatPct(row.gainLossPct)}</td>
                </tr>`;
              }
              return `<tr>
                <td>${formatPortfolioMonth(row.date)}</td>
                <td class="num">${formatEur(row.value)}</td>
                <td class="num ${numberClass(row.gainLoss)}">${formatSignedEur(row.gainLoss)}</td>
                <td class="num ${numberClass(row.gainLossPct)}">${formatPct(row.gainLossPct)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function clampDateToRange(date) {
    if (!date) return date;
    if (state.ttMinDate && date < state.ttMinDate) return state.ttMinDate;
    if (state.ttMaxDate && date > state.ttMaxDate) return state.ttMaxDate;
    return date;
  }

  function nearestHistoryDate(targetDate) {
    const dates = state.portfolioHistoryDates;
    if (!dates.length || !targetDate) return targetDate;
    if (dates.includes(targetDate)) return targetDate;
    let nearest = dates[0];
    let best = Math.abs(new Date(nearest) - new Date(targetDate));
    for (const d of dates) {
      const diff = Math.abs(new Date(d) - new Date(targetDate));
      if (diff < best) { nearest = d; best = diff; }
    }
    return nearest;
  }

  function updateHistoryChartSelection() {
    valuationChart.draw();
  }

  function syncHistoryDate(date, source = 'selector') {
    if (!date) return;
    const snapped = nearestHistoryDate(clampDateToRange(date));
    state.selectedHistoryDate = snapped;
    const input = $('tt-date');
    if (input && input.value !== snapped) input.value = snapped;
    loadTimeTravel(snapped);
    updateHistoryChartSelection(snapped, source === 'selector');
  }

  async function loadTimeTravel(date) {
    const container = $('tt-content');
    container.innerHTML = '<div class="muted-empty">Loading snapshot…</div>';
    try {
      const extra = `&includeOtherBrokers=${state.includeOtherBrokers ? '1' : '0'}`;
      const resp = await fetch(`/api/time-travel?date=${encodeURIComponent(date)}${extra}`);
      const data = await resp.json();
      renderTimeTravel(data);
    } catch (err) {
      container.innerHTML = '<div class="muted-empty">Failed to load snapshot.</div>';
      console.error(err);
    }
  }

  function isTracker(h) {
    return TRACKER_KEYWORDS.some((kw) => (h.name || '').toLowerCase().includes(kw.toLowerCase()));
  }

  function renderTimeTravel(data) {
    const container = $('tt-content');
    const header = $('tt-header-display');
    if (!data.holdings?.length) {
      container.innerHTML = '<div class="muted-empty">No holdings on this date.</div>';
      header.innerHTML = '';
      return;
    }

    const fmt = (v) => '€ ' + Math.abs(v).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const sign = (v) => (v > 0 ? '+' : v < 0 ? '-' : '');

    const renderRow = (h) => {
      const priceStr = h.price != null ? formatPrice(h.price, h.currency) : '—';
      let changeHtml = '';
      if (h.daily_change_eur != null) {
        const pct = h.daily_change_pct != null ? ` (${sign(h.daily_change_pct)}${Math.abs(h.daily_change_pct).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)` : '';
        changeHtml = `<div class="tt-holding-change ${numberClass(h.daily_change_eur)}">${sign(h.daily_change_eur)}${fmt(h.daily_change_eur)}${pct}</div>`;
      }
      let ytdHtml = '';
      if (h.ytd_change_eur != null && h.shares) {
        const perShare = h.ytd_change_eur / h.shares;
        const pct = h.ytd_change_pct != null ? ` (${sign(h.ytd_change_pct)}${Math.abs(h.ytd_change_pct).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)` : '';
        ytdHtml = `<div class="tt-holding-ytd ${numberClass(h.ytd_change_eur)}">YTD: ${sign(perShare)}${fmt(perShare)}/share${pct}</div>`;
      }
      return `
        <div class="tt-holding-row is-clickable" data-perf-key="${h.is_manual ? 'm' : 's'}-${h.id}">
          <div>
            <div class="tt-holding-name">${escapeHtml(h.name)}</div>
            <div class="tt-holding-meta">${escapeHtml(h.exchange || '')} | ${priceStr} × ${h.shares}</div>
          </div>
          <div class="tt-holding-right">
            <div class="tt-holding-value">${h.total_value_eur != null ? fmt(h.total_value_eur) : '—'}</div>
            ${changeHtml}${ytdHtml}
          </div>
        </div>
      `;
    };

    const renderSection = (title, items, id) => {
      if (!items.length) return '';
      const collapsed = state.ttSectionStates[id] === true;
      return `
        <div class="tt-section">
          <div class="tt-section-header" data-section="${id}">
            <div class="tt-section-title">${title}</div>
            <span class="tt-section-toggle ${collapsed ? 'collapsed' : ''}" id="${id}-toggle">▾</span>
          </div>
          <div class="tt-section-content ${collapsed ? 'collapsed' : ''}" id="${id}-content">
            ${items.map(renderRow).join('')}
          </div>
        </div>
      `;
    };

    const manuals = data.holdings.filter((h) => h.is_manual);
    const rest = data.holdings.filter((h) => !h.is_manual);
    const stocks = rest.filter((h) => !isTracker(h));
    const trackers = rest.filter(isTracker);
    const hist = state.latestPortfolioHistoryData;
    const dateIdx = hist?.dates?.indexOf(data.date) ?? -1;
    const investedOnDate = dateIdx >= 0 ? hist.invested[dateIdx] : null;
    const openCostOnDate = dateIdx >= 0 ? (hist.open_cost || [])[dateIdx] : null;
    const value = data.total_value_eur;
    const investedPnl = investedOnDate != null ? value - investedOnDate : null;
    const investedPct = investedOnDate > 0 ? (investedPnl / investedOnDate) * 100 : null;
    const openPnl = openCostOnDate != null ? value - openCostOnDate : null;
    const openPct = openCostOnDate > 0 ? (openPnl / openCostOnDate) * 100 : null;

    header.innerHTML = `
      <div class="tt-header">
        <div>
          <div class="stat-label">Portfolio value</div>
          <div class="tt-header-value">${formatEur(value)}</div>
          ${metricChangeHtml(data.daily_change_eur, data.daily_change_pct, { horizon: '1d' })}
        </div>
        <div>
          <div class="stat-label">Net invested</div>
          <div class="tt-header-value">${investedOnDate != null ? formatEur(investedOnDate) : '—'}</div>
          ${metricChangeHtml(investedPnl, investedPct)}
        </div>
        <div>
          <div class="stat-label">Open positions</div>
          <div class="tt-header-value">${openCostOnDate != null ? formatEur(openCostOnDate) : '—'}</div>
          ${metricChangeHtml(openPnl, openPct)}
        </div>
      </div>
    `;
    container.innerHTML = [
      renderSection('Stocks', stocks, 'tt-stocks'),
      renderSection("Trackers (ETF's)", trackers, 'tt-trackers'),
      renderSection('Other brokers', manuals, 'tt-other-brokers'),
    ].join('');
  }

  async function loadPortfolioValuationChart() {
    try {
      const resp = await fetch(`/api/portfolio-valuation-history${otherBrokersQueryParam()}`);
      const data = await resp.json();
      if (!data.dates?.length) return false;

      state.portfolioHistoryDates = data.dates;
      state.latestPortfolioHistoryData = data;
      renderPortfolioHistoryTable(data);

      const lastDate = data.dates[data.dates.length - 1];
      state.selectedHistoryDate = state.selectedHistoryDate || lastDate;
      valuationChart.init();
      renderChartRangeButtons();
      updateScaleButton();
      valuationChart.draw();
      return true;
    } catch (err) {
      console.error('Failed to load chart', err);
      await checkServerStatus();
      return false;
    }
  }

  async function initTimeTravel() {
    try {
      const resp = await fetch('/api/time-travel/range');
      const range = await resp.json();
      state.ttMinDate = range.min_date;
      state.ttMaxDate = range.max_date;
      if (!state.ttMinDate || !state.ttMaxDate) return;
      const input = $('tt-date');
      input.min = state.ttMinDate;
      input.max = state.ttMaxDate;
      input.value = state.ttMaxDate;
      syncHistoryDate(state.ttMaxDate, 'init');
    } catch (err) {
      console.error('Failed to init time travel', err);
    }
  }

  function shiftDate(delta) {
    const current = $('tt-date').value;
    const dates = state.portfolioHistoryDates;
    if (!current || !dates.length) return;
    const idx = dates.indexOf(current);
    let nextIdx;
    if (idx === -1) {
      if (delta > 0) {
        nextIdx = dates.findIndex((d) => d > current);
        if (nextIdx === -1) return;
      } else {
        nextIdx = dates.slice().reverse().findIndex((d) => d < current);
        if (nextIdx === -1) return;
        nextIdx = dates.length - 1 - nextIdx;
      }
    } else {
      nextIdx = idx + delta;
    }
    if (nextIdx < 0 || nextIdx >= dates.length) return;
    syncHistoryDate(dates[nextIdx], 'nav');
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
    await loadOtherBrokersPanel();
    if (state.includeOtherBrokers) {
      await Promise.all([
        loadPortfolioSummary(),
        loadPortfolioValuationChart(),
        loadHoldings(),
        loadPerformance(),
        refreshTimeTravel(),
      ]);
    }
  }

  async function refreshTimeTravel() {
    if ($('tt-date').value) await loadTimeTravel($('tt-date').value);
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

  function closeOverlay(id) {
    $(id).classList.remove('show');
  }

  function openSettings() {
    $('settings-overlay').classList.add('show');
    loadGmailStatus();
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
    const disconnectBtn = $('gmail-disconnect-btn');

    setup.hidden = Boolean(status.connected);
    account.hidden = !status.connected;
    scanBtn.hidden = !status.connected;
    if (sidebarScan) sidebarScan.hidden = !status.connected;
    disconnectBtn.hidden = !status.connected;

    if (status.connected) {
      $('gmail-account-email').textContent = status.email || 'Connected mailbox';
      const proto = status.secure ? 'SSL/TLS' : 'STARTTLS';
      $('gmail-account-meta').textContent = `${status.host}:${status.port} · ${proto}`;
      const last = status.lastScan
        ? ` Last scan ${new Date(status.lastScan).toLocaleString()}.`
        : '';
      copy.textContent = `Inbox connected.${last} Scan adds DEGIRO confirmation fills without replacing history.`;
    } else {
      copy.textContent = 'Same credentials as Easereader: Gmail address plus an app password. The inbox is read over IMAP (SMTP can only send).';
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
    $('scan-overlay').classList.add('show');
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
    $('confirm-overlay').classList.add('show');
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
    $('manual-overlay').classList.add('show');
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
    const remainingNote = lot.remaining_qty !== lot.original_qty
      ? `${formatShares(lot.remaining_qty)} of ${formatShares(lot.original_qty)} shares remaining`
      : `${formatShares(lot.remaining_qty)} shares`;
    const closed = holding.kind === 'closed' || lot.realized;
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
          <div class="lot-stat-label">Cost</div>
          <div class="lot-stat-value">${formatEur(lot.cost_eur || 0)}</div>
        </div>
        <div class="lot-stat">
          <div class="lot-stat-label">${closed ? 'Sold for' : 'Now'}</div>
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
      ${closedNote}
    `;
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

    container.innerHTML = groups.map((group) => `
      <div class="perf-group">
        <div class="perf-group-title">${group.title}</div>
        ${group.items.map((h) => {
          const collapsed = state.perfCollapsed[h.key] !== false;
          const closed = h.kind === 'closed';
          const selected = state.selectedHoldingKey === h.key;
          const lots = [...(h.lots || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
          const meta = closed
            ? `Sold · ${h.lots.length} purchase${h.lots.length === 1 ? '' : 's'} · realized`
            : `${formatShares(h.shares)} shares · cost ${formatEur(h.cost_eur || 0)} · now ${h.value_eur != null ? formatEur(h.value_eur) : '—'}`;
          return `
            <div class="perf-holding${selected ? ' selected' : ''}" id="perf-${h.key}">
              <div class="perf-holding-row">
                <button class="perf-chevron${collapsed ? ' collapsed' : ''}" type="button" data-perf-toggle="${h.key}" aria-label="${collapsed ? 'Expand purchases' : 'Collapse purchases'}"><span>▾</span></button>
                <button class="perf-holding-head" type="button" data-perf-select="${h.key}">
                  <div>
                    <div class="perf-holding-name">${escapeHtml(h.name)}</div>
                    <div class="perf-holding-meta">${meta}</div>
                  </div>
                  <div class="perf-holding-right">
                    <div class="perf-holding-pct ${numberClass(h.gain_pct)}">${h.gain_pct != null ? formatPct(h.gain_pct) : '—'}</div>
                    <div class="perf-holding-gain ${numberClass(h.gain_eur)}">${h.gain_eur != null ? formatSignedEur(h.gain_eur) : '—'}</div>
                  </div>
                </button>
              </div>
              ${collapsed ? '' : `
                <div class="perf-lots">
                  ${lots.map((lot) => `
                    <button class="perf-lot${state.selectedLotId === lot.id ? ' selected' : ''}" type="button" data-lot-id="${escapeHtml(lot.id)}">
                      <div>
                        <div class="perf-lot-date">${formatDay(lot.date)}</div>
                        <div class="perf-lot-meta">${formatShares(lot.remaining_qty)} shares${lot.buy_price != null ? ` @ ${formatPrice(lot.buy_price, lot.currency)}` : ''}${lot.sell_date ? ` · sold ${formatDay(lot.sell_date)}` : ''} · ${formatEur(lot.cost_eur || 0)}</div>
                      </div>
                      <div class="perf-lot-right">
                        <div class="perf-lot-pct ${numberClass(lot.gain_pct)}">${lot.gain_pct != null ? formatPct(lot.gain_pct) : '—'}</div>
                        <div class="perf-lot-gain ${numberClass(lot.gain_eur)}">${lot.gain_eur != null ? formatSignedEur(lot.gain_eur) : '—'}</div>
                      </div>
                    </button>
                  `).join('')}
                </div>
              `}
            </div>
          `;
        }).join('')}
      </div>
    `).join('');

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
      const resp = await fetch(path);
      const data = await resp.json();
      if (state.selectedHoldingKey !== key || state.selectedLotId) return;
      state.lotChartData = {
        dates: data.dates || [],
        values: data.values || [],
        costs: data.costs || null,
        mode: 'position',
      };
      renderLotRangeButtons();
      lotChart.draw();
    } catch (err) {
      console.error('Failed to load position chart', err);
    }
  }

  function isCompactView() {
    return window.matchMedia('(max-width: 860px)').matches;
  }

  function revealPerfDetail() {
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

  async function selectPosition(key, { scroll = false } = {}) {
    const holding = state.performanceHoldings.find((h) => h.key === key);
    if (!holding) return;
    state.selectedHoldingKey = key;
    state.selectedLotId = null;
    state.perfCollapsed[key] = false;
    renderPerformance();
    revealPerfDetail();
    if (scroll && !isCompactView()) {
      document.getElementById(`perf-${key}`)?.scrollIntoView({ block: 'nearest' });
    }
    await loadPositionChart(holding);
  }

  function setPerfExpanded(expanded) {
    state.perfDetailExpanded = expanded;
    $('perf-layout').classList.toggle('is-expanded', expanded);
    const btn = $('perf-expand-btn');
    btn.classList.toggle('is-back', expanded);
    btn.innerHTML = expanded
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg> Holdings'
      : 'Expand';
    btn.setAttribute('aria-label', expanded ? 'Back to holdings' : 'Expand chart');
    requestAnimationFrame(() => lotChart.draw());
  }

  function openHoldingPerformance(key) {
    setView('performance');
    selectPosition(key, { scroll: true });
  }

  async function loadPerformance() {
    try {
      const resp = await fetch(`/api/performance${otherBrokersQueryParam()}`);
      const data = await resp.json();
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

  function setSidebarOpen(open) {
    $('sidebar').classList.toggle('open', open);
    const backdrop = $('sidebar-backdrop');
    if (backdrop) backdrop.hidden = !open;
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    $('menu-btn').addEventListener('click', () => {
      setSidebarOpen(!$('sidebar').classList.contains('open'));
    });
    $('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
    $('theme-toggle').addEventListener('click', toggleTheme);
    $('settings-btn').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', () => closeOverlay('settings-overlay'));
    $('settings-overlay').addEventListener('click', (e) => {
      if (e.target === $('settings-overlay')) closeOverlay('settings-overlay');
    });
    $('gmail-save-credentials').addEventListener('click', saveGmailCredentials);
    document.querySelectorAll('[data-mail-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyMailboxPreset(btn.dataset.mailPreset));
    });
    $('gmail-scan-btn').addEventListener('click', () => scanGmailConfirmations());
    $('sidebar-scan-btn').addEventListener('click', () => scanGmailConfirmations());
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
        refreshTimeTravel(),
      ]);
    });
    $('chart-range-selector').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      state.selectedChartRange = btn.dataset.range;
      renderChartRangeButtons();
      applyChartRange();
    });
    $('lot-range-selector').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      state.selectedPerfRange = btn.dataset.range;
      renderLotRangeButtons();
      lotChart.hoverIndex = null;
      lotChart.draw();
    });
    $('perf-expand-btn').addEventListener('click', () => setPerfExpanded(!state.perfDetailExpanded));
    window.matchMedia('(max-width: 860px)').addEventListener('change', (e) => {
      if (e.matches && (state.selectedHoldingKey || state.selectedLotId)) {
        setPerfExpanded(true);
      } else if (!e.matches) {
        setPerfExpanded(false);
      }
    });
    $('chart-scale-btn').addEventListener('click', () => {
      state.chartAutoScale = !state.chartAutoScale;
      updateScaleButton();
      applyChartRange();
    });
    $('tt-prev').addEventListener('click', () => shiftDate(-1));
    $('tt-next').addEventListener('click', () => shiftDate(1));
    $('tt-date').addEventListener('change', () => syncHistoryDate($('tt-date').value, 'selector'));
    $('tt-content').addEventListener('click', (e) => {
      const holding = e.target.closest('[data-perf-key]');
      if (holding) {
        openHoldingPerformance(holding.dataset.perfKey);
        return;
      }
      const header = e.target.closest('.tt-section-header');
      if (!header) return;
      const id = header.dataset.section;
      const content = document.getElementById(`${id}-content`);
      const toggle = document.getElementById(`${id}-toggle`);
      content.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
      state.ttSectionStates[id] = content.classList.contains('collapsed');
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
    $('holdings-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-perf-key]');
      if (!row) return;
      openHoldingPerformance(row.dataset.perfKey);
    });
    $('perf-holdings').addEventListener('click', (e) => {
      const lotBtn = e.target.closest('[data-lot-id]');
      if (lotBtn) {
        selectLot(lotBtn.dataset.lotId);
        return;
      }
      const toggle = e.target.closest('[data-perf-toggle]');
      if (toggle) {
        const key = toggle.dataset.perfToggle;
        state.perfCollapsed[key] = state.perfCollapsed[key] !== false ? false : true;
        renderPerformance();
        return;
      }
      const select = e.target.closest('[data-perf-select]');
      if (select) selectPosition(select.dataset.perfSelect);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
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
      }
    });
  }

  async function initialize() {
    initTheme();
    bindEvents();
    renderLotRangeButtons();
    setInterval(checkServerStatus, 5000);

    const online = await checkServerStatus();
    if (!online) {
      setLoading('', false);
      return;
    }

    await fetchServerConfig();
    initIncludeOtherBrokers();
    await loadUserPreferences();
    setLoading('Loading holdings, summary, and history…', true);

    const [summary, chartOk] = await Promise.all([
      loadPortfolioSummary(),
      loadPortfolioValuationChart(),
      loadHoldings(),
      loadPerformance(),
      initTimeTravel(),
      loadOtherBrokersPanel(),
      loadGmailStatus(),
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
