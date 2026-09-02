/**
 * Parse DEGIRO transaction confirmation emails (.eml / RFC822 / HTML).
 * One mail can contain several fills; each OrderID becomes a row.
 */
const { col } = require('./config');

const MONTHS = {
  jan: 1, january: 1, januari: 1,
  feb: 2, february: 2, februari: 2,
  mrt: 3, mar: 3, maart: 3, march: 3,
  apr: 4, april: 4,
  mei: 5, may: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8, augustus: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, october: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const GREETING_RE = /^(geachte|dear|beste|hallo|hello)\b/i;
const SKIP_LINE_RE = /^(de volgende order|the following order|wereldwijd beleggen|met vriendelijke|kind regards|degiro b\.?v)/i;

function decodeQuotedPrintable(str) {
  const stripped = String(str).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(stripped.slice(i + 1, i + 3))) {
      bytes.push(parseInt(stripped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(stripped.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeMimeWord(value) {
  if (!value) return '';
  const unfolded = String(value).replace(/\r?\n[ \t]+/g, '');
  return unfolded.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, _charset, enc, text) => {
    if (enc.toUpperCase() === 'B') {
      return Buffer.from(text, 'base64').toString('utf8');
    }
    return decodeQuotedPrintable(text.replace(/_/g, ' '));
  });
}

function unfoldHeaders(raw) {
  return String(raw).replace(/\r?\n[ \t]+/g, ' ');
}

function parseHeaders(headerBlock) {
  const headers = {};
  for (const line of unfoldHeaders(headerBlock).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]} ${value}` : value;
  }
  return headers;
}

function headerParam(value, name) {
  if (!value) return null;
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, 'i');
  const match = value.match(re);
  return match ? (match[1] || match[2]) : null;
}

function decodeBody(body, encoding) {
  const enc = String(encoding || '7bit').toLowerCase();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  if (enc === 'base64') {
    return Buffer.from(String(body).replace(/\s/g, ''), 'base64').toString('utf8');
  }
  return String(body);
}

function splitHeaderBody(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const match = text.match(/\r?\n\r?\n/);
  if (!match) return { headers: {}, body: text };
  const idx = match.index;
  return {
    headers: parseHeaders(text.slice(0, idx)),
    body: text.slice(idx + match[0].length),
  };
}

function extractMimePart(raw) {
  const { headers, body } = splitHeaderBody(raw);
  const contentType = headers['content-type'] || 'text/html; charset=utf-8';
  const encoding = headers['content-transfer-encoding'];

  if (/multipart\//i.test(contentType)) {
    const boundary = headerParam(contentType, 'boundary');
    if (!boundary) {
      return { headers, html: decodeBody(body, encoding), text: '' };
    }
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = body.split(new RegExp(`--${escaped}(?:--)?`));
    let html = '';
    let text = '';
    for (const part of parts) {
      if (!part.trim()) continue;
      const nested = extractMimePart(part.replace(/^\r?\n/, ''));
      if (nested.html && !html) html = nested.html;
      if (nested.text && !text) text = nested.text;
    }
    return { headers, html, text };
  }

  const decoded = decodeBody(body, encoding);
  if (/text\/html/i.test(contentType)) return { headers, html: decoded, text: '' };
  if (/text\/plain/i.test(contentType)) return { headers, html: '', text: decoded };
  return { headers, html: decoded, text: '' };
}

function decodeEntities(str) {
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').trim();
}

function normalizeLabel(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/:$/, '')
    .trim();
  if (!s) return null;
  if (s === 'orderid' || s === 'order id' || s === 'order-id') return 'orderId';
  if (s.startsWith('transactiedatum') || s.startsWith('transaction date')) return 'date';
  if (s === 'isin') return 'isin';
  if (s === 'opdracht' || s === 'side' || s === 'action' || s === 'buy/sell') return 'side';
  if (s === 'beurs' || s === 'exchange' || s === 'reference exchange') return 'exchange';
  if (s === 'handelsplaats' || s === 'venue' || s === 'trading venue') return 'venue';
  if (s === 'aantal' || s === 'quantity' || s === 'qty') return 'quantity';
  if (s === 'koers' || s === 'price') return 'price';
  if (s.startsWith('lokale waarde') || s.startsWith('local value')) return 'localValue';
  if (s === 'waarde' || s === 'value') return 'value';
  if (s.startsWith('wisselkoers') || s.startsWith('exchange rate')) return 'exchangeRate';
  if (s.includes('transactiekosten') || s.includes('transaction cost') || s.includes('third party')) return 'fees';
  if (s.startsWith('totale kosten') || s.startsWith('total cost')) return 'totalFees';
  if (s === 'totaal' || s === 'total') return 'total';
  return null;
}

function parseEuropeanNumber(value) {
  if (value == null || value === '') return NaN;
  const s = String(value).trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    }
    return parseFloat(s.replace(/,/g, ''));
  }
  if (s.includes(',')) return parseFloat(s.replace(',', '.'));
  return parseFloat(s);
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const leading = s.match(/^([A-Z]{3})\s+(.+)$/);
  if (leading) return { currency: leading[1], amount: parseEuropeanNumber(leading[2]) };
  const trailing = s.match(/^(.+?)\s+([A-Z]{3})$/);
  if (trailing) return { currency: trailing[2], amount: parseEuropeanNumber(trailing[1]) };
  const amount = parseEuropeanNumber(s);
  if (Number.isNaN(amount)) return null;
  return { currency: 'EUR', amount };
}

function parseConfirmationDateTime(value) {
  const s = String(value || '').trim();
  const match = s.match(/^(\d{1,2})\s+([A-Za-z.]+)\s+(\d{4})(?:,?\s*(\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (!match) return { date: null, time: '' };
  const month = MONTHS[match[2].toLowerCase().replace(/\./g, '')];
  if (!month) return { date: null, time: '' };
  const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const time = match[4] || '';
  return { date, time };
}

function productFromSubject(subject) {
  const decoded = decodeMimeWord(subject);
  const match = decoded.match(/(?:Koop|Verkoop|Buy|Sell)\s+\d+(?:[.,]\d+)?\s+(.+?)\s+@/i);
  return match ? match[1].trim() : '';
}

function collectHtmlEvents(html) {
  const events = [];
  const productRe = /font-weight:\s*bold;\s*font-size:\s*16px;[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = productRe.exec(html))) {
    const name = stripTags(match[1]);
    if (name && !GREETING_RE.test(name) && !SKIP_LINE_RE.test(name)) {
      events.push({ type: 'product', name, index: match.index });
    }
  }
  const pairRe = /<singleline[^>]*>([\s\S]*?)<\/singleline>[\s\S]*?<strong>([\s\S]*?)<\/strong>/gi;
  while ((match = pairRe.exec(html))) {
    events.push({
      type: 'field',
      label: stripTags(match[1]),
      value: stripTags(match[2]),
      index: match.index,
    });
  }
  events.sort((a, b) => a.index - b.index);
  return events;
}

function blocksFromEvents(events, fallbackProduct) {
  const blocks = [];
  let product = fallbackProduct || '';
  let current = {};

  const flush = () => {
    if (current.orderId || current.isin) {
      if (!current.product) current.product = product;
      blocks.push(current);
    }
    current = {};
  };

  for (const event of events) {
    if (event.type === 'product') {
      flush();
      product = event.name;
      continue;
    }
    const key = normalizeLabel(event.label);
    if (!key) continue;
    if (key === 'orderId' && current.orderId) flush();
    if (product && !current.product) current.product = product;
    current[key] = event.value;
  }
  flush();
  return blocks;
}

function blocksFromPlainText(text, fallbackProduct) {
  const lines = String(text)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const blocks = [];
  let product = fallbackProduct || '';
  let current = {};

  const flush = () => {
    if (current.orderId || current.isin) {
      if (!current.product) current.product = product;
      blocks.push(current);
    }
    current = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const key = normalizeLabel(lines[i]);
    if (key && i + 1 < lines.length && !normalizeLabel(lines[i + 1])) {
      if (key === 'orderId' && current.orderId) flush();
      if (product && !current.product) current.product = product;
      current[key] = lines[i + 1];
      i += 1;
      continue;
    }
    if (
      lines[i].length > 12
      && !GREETING_RE.test(lines[i])
      && !SKIP_LINE_RE.test(lines[i])
      && !normalizeLabel(lines[i])
      && /[A-Za-z]{4,}/.test(lines[i])
      && !/^https?:/i.test(lines[i])
    ) {
      product = lines[i];
    }
  }
  flush();
  return blocks;
}

function blockToRow(block) {
  const { date, time } = parseConfirmationDateTime(block.date);
  if (!date || !block.isin) return null;

  const moneyPrice = parseMoney(block.price);
  const moneyValue = parseMoney(block.value);
  const moneyTotal = parseMoney(block.total);
  const moneyFees = parseMoney(block.fees || block.totalFees);
  const qtyAbs = Math.abs(parseEuropeanNumber(block.quantity));
  if (!qtyAbs) return null;

  const isSell = /verkoop|sell|sale/.test(String(block.side || '').toLowerCase());
  const quantity = isSell ? -Math.round(qtyAbs) : Math.round(qtyAbs);
  const price = moneyPrice?.amount;
  const currency = moneyPrice?.currency || 'EUR';
  const fx = block.exchangeRate != null && block.exchangeRate !== ''
    ? parseEuropeanNumber(block.exchangeRate)
    : 1;

  let valueEur = moneyValue?.amount;
  if (valueEur == null && price != null && !Number.isNaN(price)) {
    valueEur = (isSell ? 1 : -1) * qtyAbs * price * (Number.isNaN(fx) ? 1 : fx);
  }
  const feesEur = moneyFees?.amount ?? null;
  let totalEur = moneyTotal?.amount;
  if (totalEur == null) {
    totalEur = (valueEur || 0) + (feesEur || 0);
  }

  return {
    [col('date')]: date,
    [col('time')]: time,
    [col('product')]: block.product || '',
    [col('isin')]: String(block.isin).trim(),
    [col('exchange')]: block.exchange || '',
    [col('quantity')]: quantity,
    [col('price')]: price,
    [col('currency')]: currency,
    [col('value_eur')]: valueEur,
    [col('total_eur')]: totalEur,
    [col('venue')]: block.venue || '',
    [col('exchange_rate')]: Number.isNaN(fx) ? 1 : fx,
    [col('fees_eur')]: feesEur,
    [col('transaction_id')]: block.orderId || '',
  };
}

function parseConfirmationSource(raw, filename = '') {
  const source = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!source.trim()) return [];

  const looksLikeMime = /^(deliver(?:ed)?-to|return-path|received:|from:|subject:|mime-version:|content-type:)/im.test(source);
  let html = '';
  let text = '';
  let subject = '';

  if (looksLikeMime || /\.eml$/i.test(filename)) {
    const mime = extractMimePart(source);
    html = mime.html || '';
    text = mime.text || '';
    subject = decodeMimeWord(mime.headers.subject || '');
  } else {
    html = source;
  }

  const fallbackProduct = productFromSubject(subject);
  let blocks = blocksFromEvents(collectHtmlEvents(html), fallbackProduct);
  if (!blocks.length) {
    const plain = html ? stripTags(html.replace(/<\/tr>/gi, '\n')) : text;
    blocks = blocksFromPlainText(plain, fallbackProduct);
  }

  return blocks.map(blockToRow).filter(Boolean);
}

function parseConfirmationEmail(raw, filename) {
  return parseConfirmationSource(raw, filename);
}

module.exports = {
  parseConfirmationEmail,
  parseConfirmationSource,
  decodeQuotedPrintable,
  parseEuropeanNumber,
  parseMoney,
  parseConfirmationDateTime,
};
