/**
 * Mailbox connection for DEGIRO confirmation emails.
 * Same credential model as Easereader (email + app password), but IMAP
 * because SMTP can only send mail — it cannot read the inbox.
 */
const { ImapFlow } = require('imapflow');
const { getDb } = require('./database');

const CONFIRMATION_SUBJECT_RE = /transactiebevestiging|transaction confirmation|transaktionsbestätigung|confirmation de transaction/i;

const IMAP_PRESETS = {
  'smtp.gmail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'imap.gmail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'smtp-mail.outlook.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'smtp.office365.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'outlook.office365.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'smtp.mail.yahoo.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  'smtp.mail.me.com': { host: 'imap.mail.me.com', port: 993, secure: true },
};

function getPref(key) {
  const row = getDb().prepare('SELECT value FROM user_preferences WHERE key = ?').get(key);
  return row?.value ?? null;
}

function setPref(key, value) {
  getDb().prepare(`
    INSERT INTO user_preferences (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

function deletePref(key) {
  getDb().prepare('DELETE FROM user_preferences WHERE key = ?').run(key);
}

function normalizeMailboxSettings({ user, password, host, port, secure }) {
  const email = String(user || '').trim();
  const rawHost = String(host || 'imap.gmail.com').trim().toLowerCase();
  const preset = IMAP_PRESETS[rawHost];
  const mapped = preset || {
    host: rawHost.replace(/^smtp\./, 'imap.'),
    port: Number(port) || 993,
    secure: secure !== false,
  };
  if (/gmail\.com$/i.test(mapped.host) || rawHost.includes('gmail')) {
    mapped.host = 'imap.gmail.com';
    mapped.port = 993;
    mapped.secure = true;
  }
  return {
    user: email,
    password: password == null ? '' : String(password),
    host: mapped.host,
    port: mapped.port,
    secure: mapped.secure !== false,
  };
}

function getStoredMailbox() {
  const user = getPref('mailbox_user');
  const password = getPref('mailbox_password');
  if (!user || !password) return null;
  return {
    user,
    password,
    host: getPref('mailbox_host') || 'imap.gmail.com',
    port: parseInt(getPref('mailbox_port') || '993', 10),
    secure: getPref('mailbox_secure') !== '0',
  };
}

function getStatus() {
  const mailbox = getStoredMailbox();
  return {
    connected: Boolean(mailbox),
    email: mailbox?.user || null,
    host: mailbox?.host || null,
    port: mailbox?.port || null,
    secure: mailbox?.secure ?? true,
    lastScan: getPref('gmail_last_scan'),
  };
}

function createClient(settings) {
  return new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
    logger: false,
  });
}

async function withMailbox(settings, fn) {
  const client = createClient(settings);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch (_err) {
      try { client.close(); } catch (_closeErr) { /* ignore */ }
    }
  }
}

async function testMailbox(settings) {
  return withMailbox(settings, async (client) => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    return true;
  });
}

async function saveMailboxCredentials(input) {
  const settings = normalizeMailboxSettings(input);
  if (!settings.user || !settings.password) {
    throw new Error('Email and password are required');
  }
  try {
    await testMailbox(settings);
  } catch (err) {
    const hint = /gmail/i.test(settings.host)
      ? ' For Gmail, use an app password (same as Easereader), not your normal password.'
      : '';
    throw new Error(`${err.message || 'Mailbox login failed'}.${hint}`);
  }
  setPref('mailbox_user', settings.user);
  setPref('mailbox_password', settings.password);
  setPref('mailbox_host', settings.host);
  setPref('mailbox_port', String(settings.port));
  setPref('mailbox_secure', settings.secure ? '1' : '0');
  setPref('gmail_email', settings.user);
  return getStatus();
}

function alreadyImported(messageId) {
  return Boolean(
    getDb().prepare('SELECT message_id FROM gmail_imports WHERE message_id = ?').get(messageId)
  );
}

function markImported(messageId, subject, transactionCount) {
  getDb().prepare(`
    INSERT INTO gmail_imports (message_id, subject, imported_at, transaction_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      subject = excluded.subject,
      imported_at = excluded.imported_at,
      transaction_count = excluded.transaction_count
  `).run(messageId, subject || '', new Date().toISOString(), transactionCount);
}

function disconnectMailbox() {
  for (const key of [
    'mailbox_user',
    'mailbox_password',
    'mailbox_host',
    'mailbox_port',
    'mailbox_secure',
    'gmail_email',
    'gmail_refresh_token',
    'gmail_access_token',
    'gmail_access_expires',
    'gmail_oauth_state',
    'gmail_client_id',
    'gmail_client_secret',
  ]) {
    deletePref(key);
  }
}

function setLastScan() {
  const stamp = new Date().toISOString();
  setPref('gmail_last_scan', stamp);
  return stamp;
}

function isConfirmationSubject(subject) {
  return CONFIRMATION_SUBJECT_RE.test(String(subject || ''));
}

function messageKey(msg) {
  const headerId = msg.envelope?.messageId || '';
  if (headerId) return headerId.replace(/^<|>$/g, '');
  return `imap-${msg.uid}`;
}

async function searchConfirmationUids(client, { newerThanDays } = {}) {
  const since = newerThanDays
    ? new Date(Date.now() - newerThanDays * 24 * 60 * 60 * 1000)
    : undefined;

  try {
    const gmraw = [
      'from:degiro.nl',
      '(subject:Transactiebevestiging OR subject:"Transaction confirmation"',
      'OR subject:Transaktionsbestätigung OR subject:"Confirmation de transaction")',
      since ? `after:${since.toISOString().slice(0, 10).replace(/-/g, '/')}` : '',
    ].filter(Boolean).join(' ');
    const uids = await client.search({ gmraw }, { uid: true });
    if (uids?.length) return uids;
  } catch (_err) {
    // Non-Gmail servers do not support X-GM-RAW.
  }

  const query = { from: 'degiro.nl' };
  if (since) query.since = since;
  return client.search(query, { uid: true });
}

async function fetchConfirmationEmails({ newerThanDays } = {}) {
  const settings = getStoredMailbox();
  if (!settings) throw new Error('Mailbox is not connected');

  return withMailbox(settings, async (client) => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const uids = await searchConfirmationUids(client, { newerThanDays });
    if (!uids?.length) return [];

    const emails = [];
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
      const subject = msg.envelope?.subject || '';
      if (!isConfirmationSubject(subject)) continue;
      const id = messageKey(msg);
      emails.push({
        id,
        subject,
        raw: msg.source,
      });
    }
    return emails;
  });
}

module.exports = {
  getStatus,
  saveMailboxCredentials,
  normalizeMailboxSettings,
  disconnectMailbox,
  alreadyImported,
  markImported,
  setLastScan,
  fetchConfirmationEmails,
  disconnectGmail: disconnectMailbox,
};
