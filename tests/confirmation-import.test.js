const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degiro-import-test-'));
process.env.DEGIRO_PORTFOLIO_DB_DIR = dir;
const { initDb, getDb } = require('../src/database');
const { parseConfirmationEmail } = require('../src/parseConfirmationEmail');
const { previewConfirmationRows, processConfirmationRows } = require('../src/importData');

function confirmation(quantity = '1.614', value = '-61.751,64', total = '-61.752,64') {
  const fields = {
    OrderID: 'existing-order', Transactiedatum: '30 okt 2025 09:05:14',
    ISIN: 'TEST-ETF', Opdracht: 'Koop', Aantal: quantity, Koers: 'EUR 38,2600',
    Waarde: `EUR ${value}`, 'Totale Kosten': 'EUR -1,00', Totaal: `EUR ${total}`,
  };
  return Object.entries(fields).map(([label, value]) => `<singleline>${label}</singleline><strong>${value}</strong>`).join('');
}

test('thousands in DEGIRO quantities remain existing fills and do not increase invested capital', async () => {
  initDb();
  const db = getDb();
  db.prepare('INSERT INTO stocks (symbol, isin, currency) VALUES (?, ?, ?)').run('TEST', 'TEST-ETF', 'EUR');
  db.prepare('INSERT INTO transactions (stock_id, quantity, price, total_eur, transaction_id) VALUES (1, 1614, 38.26, -61752.64, ?)').run('existing-order');
  const rows = parseConfirmationEmail(confirmation());
  assert.equal(rows[0].Quantity, 1614);
  assert.equal(previewConfirmationRows(rows)[0].duplicate, true);
  const result = await processConfirmationRows(rows);
  assert.equal(result.newTransactions, 0);
  assert.equal(db.prepare('SELECT SUM(ABS(total_eur)) amount FROM transactions').get().amount, 61752.64);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_batches').get().n, 0);
});

test('ordinary decimal prices and multiple thousands groups parse correctly', () => {
  const row = parseConfirmationEmail(confirmation('1.234.567', '-47.233.533,42', '-47.233.534,42'))[0];
  assert.equal(row.Quantity, 1234567);
  assert.equal(row.Price, 38.26);
  const small = parseConfirmationEmail(confirmation('2', '-76,52', '-77,52'))[0];
  assert.equal(small.Quantity, 2);
});

test('inconsistent confirmation amounts fail before preview or database writes', async () => {
  assert.throws(() => parseConfirmationEmail(confirmation('2')), /Inconsistent amounts/);
  const row = parseConfirmationEmail(confirmation())[0];
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  await assert.rejects(processConfirmationRows([{ ...row, Quantity: 2 }]), /Inconsistent amounts/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, before);
  assert.throws(() => parseConfirmationEmail(confirmation('1.614', '-61.751,64', '-130.000,00')), /Inconsistent amounts/);
});

test('a scan imports only the new purchase and a repeated import adds nothing', async () => {
  const existing = parseConfirmationEmail(confirmation())[0];
  const purchase = { ...existing, 'Transaction ID': 'new-order', Quantity: 11, Price: 48.47, 'Value EUR': -533.17, 'Total EUR': -534.17 };
  const preview = previewConfirmationRows([existing, purchase]);
  assert.deepEqual(preview.map(fill => fill.duplicate), [true, false]);
  const before = getDb().prepare('SELECT SUM(ABS(total_eur)) amount FROM transactions').get().amount;
  assert.equal((await processConfirmationRows([existing, purchase])).newTransactions, 1);
  const after = getDb().prepare('SELECT SUM(ABS(total_eur)) amount FROM transactions').get().amount;
  assert.ok(Math.abs(after - before - 534.17) < 0.000001);
  assert.equal((await processConfirmationRows([existing, purchase])).newTransactions, 0);
});

test.after(() => {
  getDb().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
