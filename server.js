// Fiorella & David wedding website: guest pages with personal links, RSVP, and an admin area.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const db = require('./src/db');
const email = require('./src/email');
const { parseGuestFile, TEMPLATE_CSV } = require('./src/importer');
const { buildWorkbook } = require('./src/exporter');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || (PROD ? null : 'dev-only-secret');
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET is not set');
  process.exit(1);
}

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(
  cookieSession({
    name: 'fyd',
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: PROD,
  })
);
app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '7d' }));
app.use('/admin/static', express.static(path.join(__dirname, 'public', 'admin'), { maxAge: 0 }));

const view = (name) => fs.readFileSync(path.join(__dirname, 'views', name), 'utf8');
const SITE = view('site.html');
const LANDING = view('landing.html');
const ADMIN = view('admin.html');

const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const newToken = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
};

async function loadHousehold(token) {
  const h = (await db.pool.query('SELECT * FROM households WHERE token=$1', [token])).rows[0];
  if (!h) return null;
  h.guests = (await db.pool.query('SELECT id,name,attending,meal,diet FROM guests WHERE household_id=$1 ORDER BY position,id', [h.id])).rows;
  return h;
}

// ---------- Guest site ----------

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => res.send(LANDING));

app.get(
  '/i/:token',
  wrap(async (req, res) => {
    const h = await loadHousehold(req.params.token);
    if (!h) return res.status(404).send(LANDING);
    const settings = await db.getSettings();
    // Record the first real visit. Link-preview robots and logged-in admins don't count.
    const ua = req.get('user-agent') || '';
    const isBot = /whatsapp|facebookexternalhit|bot|crawler|spider|preview/i.test(ua);
    if (!h.opened_at && !isBot && !(req.session && req.session.adminId)) {
      await db.pool.query('UPDATE households SET opened_at=now() WHERE id=$1 AND opened_at IS NULL', [h.id]);
    }
    const boot = {
      token: h.token,
      type: h.type,
      lang: h.lang,
      guests: h.guests,
      message: h.message,
      responded: Boolean(h.responded_at),
      locked: db.isLocked(settings),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.send(SITE.replace('/*__BOOT__*/null', safeJson(boot)).replace('__BASE__', baseUrl(req)));
  })
);

app.post(
  '/api/rsvp/:token',
  wrap(async (req, res) => {
    const h = await loadHousehold(req.params.token);
    if (!h) return res.status(404).json({ error: 'not_found' });
    const settings = await db.getSettings();
    if (db.isLocked(settings)) return res.status(423).json({ error: 'locked' });

    const body = req.body || {};
    const incoming = Array.isArray(body.guests) ? body.guests : [];
    const byId = new Map(incoming.map((g) => [Number(g.id), g]));
    const updates = [];
    for (const g of h.guests) {
      const inG = byId.get(g.id);
      if (!inG || typeof inG.attending !== 'boolean') return res.status(400).json({ error: 'incomplete' });
      let meal = null;
      let diet = '';
      if (inG.attending) {
        if (h.type === 'day') {
          if (!['meat', 'veg', 'vegan'].includes(inG.meal)) return res.status(400).json({ error: 'meal_required' });
          meal = inG.meal;
        }
        diet = String(inG.diet || '').trim().slice(0, 500);
      }
      updates.push({ id: g.id, attending: inG.attending, meal, diet });
    }
    const message = String(body.message || '').trim().slice(0, 2000);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        await client.query('UPDATE guests SET attending=$1, meal=$2, diet=$3 WHERE id=$4 AND household_id=$5', [u.attending, u.meal, u.diet, u.id, h.id]);
      }
      await client.query(
        `UPDATE households SET responded_at=now(), message=$1,
           message_at = CASE WHEN $1 <> message THEN now() ELSE message_at END,
           opened_at = COALESCE(opened_at, now())
         WHERE id=$2`,
        [message, h.id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const fresh = await loadHousehold(h.token);
    let emailed = false;
    if (fresh.email && email.configured()) {
      const lang = body.lang === 'es' || body.lang === 'en' ? body.lang : fresh.lang;
      const m = email.confirmation({ lang, type: fresh.type, guests: fresh.guests, message: fresh.message, link: `${baseUrl(req)}/i/${fresh.token}` });
      const r = await email.send({ to: fresh.email, toName: fresh.guests.map((g) => g.name).join(' & '), ...m });
      emailed = r.ok;
    }
    res.json({ ok: true, guests: fresh.guests, message: fresh.message, emailed });
  })
);

// ---------- Admin ----------

app.get(['/admin', '/admin/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(ADMIN);
});

const api = express.Router();
app.use('/admin/api', api);

// Every change must come from our own page (blocks cross-site form posts).
api.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'fyd-admin') return res.status(403).json({ error: 'forbidden' });
  next();
});

const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}
const noteFail = (ip) => attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);

api.get(
  '/me',
  wrap(async (req, res) => {
    const admins = (await db.pool.query('SELECT id,email,name,password_hash IS NOT NULL AS ready FROM admins ORDER BY id')).rows;
    const me = admins.find((a) => a.id === (req.session && req.session.adminId)) || null;
    res.json({
      me: me ? { name: me.name, email: me.email } : null,
      accounts: admins.map((a) => ({ name: a.name, email: a.email, ready: a.ready })),
    });
  })
);

api.post(
  '/login',
  wrap(async (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'too_many' });
    const { email: em, password } = req.body || {};
    const a = (await db.pool.query('SELECT * FROM admins WHERE lower(email)=lower($1)', [String(em || '')])).rows[0];
    const ok = a && a.password_hash && (await bcrypt.compare(String(password || ''), a.password_hash));
    if (!ok) {
      noteFail(req.ip);
      return res.status(401).json({ error: 'bad_login' });
    }
    req.session.adminId = a.id;
    res.json({ ok: true });
  })
);

// First-time setup: each admin chooses a password once, proving themselves with the setup code.
api.post(
  '/setup',
  wrap(async (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'too_many' });
    const { email: em, code, password } = req.body || {};
    const expected = process.env.SETUP_CODE || '';
    const given = String(code || '');
    const codeOk = expected.length >= 8 && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    const a = (await db.pool.query('SELECT * FROM admins WHERE lower(email)=lower($1)', [String(em || '')])).rows[0];
    if (!codeOk || !a || a.password_hash) {
      noteFail(req.ip);
      return res.status(400).json({ error: 'bad_setup' });
    }
    if (String(password || '').length < 10) return res.status(400).json({ error: 'weak_password' });
    await db.pool.query('UPDATE admins SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(password), 12), a.id]);
    req.session.adminId = a.id;
    res.json({ ok: true });
  })
);

api.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

api.use((req, res, next) => {
  if (!req.session || !req.session.adminId) return res.status(401).json({ error: 'login_required' });
  next();
});

async function allHouseholds() {
  const hs = (await db.pool.query('SELECT * FROM households ORDER BY id')).rows;
  const gs = (await db.pool.query('SELECT * FROM guests ORDER BY household_id,position,id')).rows;
  const map = new Map(hs.map((h) => [h.id, { ...h, guests: [] }]));
  for (const g of gs) if (map.has(g.household_id)) map.get(g.household_id).guests.push({ id: g.id, name: g.name, attending: g.attending, meal: g.meal, diet: g.diet });
  return [...map.values()];
}

api.get(
  '/data',
  wrap(async (req, res) => {
    const settings = await db.getSettings();
    res.json({
      households: await allHouseholds(),
      settings,
      locked: db.isLocked(settings),
      emailConfigured: email.configured(),
      baseUrl: baseUrl(req),
    });
  })
);

function cleanHousehold(b) {
  const names = (Array.isArray(b.names) ? b.names : []).map((n) => String(n).trim().slice(0, 80)).filter(Boolean);
  if (!names.length) return { error: 'names_required' };
  if (names.length > 12) return { error: 'too_many_names' };
  if (!['day', 'eve'].includes(b.type)) return { error: 'type_required' };
  if (!['en', 'es'].includes(b.lang)) return { error: 'lang_required' };
  return { names, type: b.type, lang: b.lang, whatsapp: String(b.whatsapp || '').trim().slice(0, 40), email: String(b.email || '').trim().slice(0, 200) };
}

async function insertHousehold(client, h) {
  const { rows } = await client.query('INSERT INTO households(token,type,lang,whatsapp,email) VALUES($1,$2,$3,$4,$5) RETURNING id', [newToken(), h.type, h.lang, h.whatsapp, h.email]);
  let pos = 0;
  for (const n of h.names) await client.query('INSERT INTO guests(household_id,position,name) VALUES($1,$2,$3)', [rows[0].id, pos++, n]);
  return rows[0].id;
}

api.post(
  '/households',
  wrap(async (req, res) => {
    const h = cleanHousehold(req.body || {});
    if (h.error) return res.status(400).json(h);
    await insertHousehold(db.pool, h);
    res.json({ ok: true });
  })
);

api.put(
  '/households/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const h = cleanHousehold(req.body || {});
    if (h.error) return res.status(400).json(h);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query('SELECT * FROM households WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!cur) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not_found' });
      }
      await client.query('UPDATE households SET type=$1, lang=$2, whatsapp=$3, email=$4 WHERE id=$5', [h.type, h.lang, h.whatsapp, h.email, id]);
      // Keep each guest's reply where the name is unchanged; add and remove the rest.
      const existing = (await client.query('SELECT * FROM guests WHERE household_id=$1 ORDER BY position,id', [id])).rows;
      const pool = [...existing];
      let pos = 0;
      for (const n of h.names) {
        const i = pool.findIndex((g) => g.name.toLowerCase() === n.toLowerCase());
        if (i >= 0) {
          const g = pool.splice(i, 1)[0];
          await client.query('UPDATE guests SET position=$1, name=$2 WHERE id=$3', [pos++, n, g.id]);
        } else {
          await client.query('INSERT INTO guests(household_id,position,name) VALUES($1,$2,$3)', [id, pos++, n]);
        }
      }
      for (const g of pool) await client.query('DELETE FROM guests WHERE id=$1', [g.id]);
      // An evening household has no meal choices.
      if (h.type === 'eve') await client.query('UPDATE guests SET meal=NULL WHERE household_id=$1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  })
);

api.delete(
  '/households/:id',
  wrap(async (req, res) => {
    await db.pool.query('DELETE FROM households WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  })
);

api.post(
  '/households/:id/sent',
  wrap(async (req, res) => {
    const sent = !(req.body && req.body.sent === false);
    await db.pool.query(`UPDATE households SET sent_at = ${sent ? 'COALESCE(sent_at, now())' : 'NULL'} WHERE id=$1`, [Number(req.params.id)]);
    res.json({ ok: true });
  })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
api.post(
  '/import',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    let parsed;
    try {
      parsed = await parseGuestFile(req.file.buffer, req.file.originalname || '');
    } catch (e) {
      return res.status(400).json({ error: 'unreadable', detail: e.message });
    }
    const existing = new Set((await allHouseholds()).map((h) => h.guests.map((g) => g.name.toLowerCase()).join('|')));
    const client = await db.pool.connect();
    let added = 0;
    const skipped = [];
    try {
      await client.query('BEGIN');
      for (const row of parsed.rows) {
        const key = row.names.map((n) => n.toLowerCase()).join('|');
        if (existing.has(key)) {
          skipped.push({ row: row.rowNumber, reason: 'already in the list: ' + row.names.join(', ') });
          continue;
        }
        existing.add(key);
        await insertHousehold(client, row);
        added++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, added, skipped: [...parsed.problems, ...skipped] });
  })
);

api.get('/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="guest-list-template.csv"');
  res.send('﻿' + TEMPLATE_CSV);
});

api.get(
  '/export.xlsx',
  wrap(async (req, res) => {
    const wb = await buildWorkbook(await allHouseholds(), baseUrl(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="wedding-rsvps-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  })
);

api.post(
  '/settings',
  wrap(async (req, res) => {
    const b = req.body || {};
    if (b.rsvp_deadline !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.rsvp_deadline) || isNaN(Date.parse(b.rsvp_deadline))) return res.status(400).json({ error: 'bad_date' });
      await db.setSetting('rsvp_deadline', b.rsvp_deadline);
    }
    if (b.rsvp_locked !== undefined) await db.setSetting('rsvp_locked', b.rsvp_locked === 'yes' ? 'yes' : 'no');
    for (const k of ['wa_en', 'wa_es']) {
      if (b[k] !== undefined) {
        const v = String(b[k]).slice(0, 1000);
        if (!v.includes('{link}')) return res.status(400).json({ error: 'link_placeholder_missing' });
        await db.setSetting(k, v);
      }
    }
    res.json({ ok: true });
  })
);

const joinNames = (names, lang) => {
  if (names.length < 2) return names[0] || '';
  const last = names[names.length - 1];
  const and = lang === 'en' ? ' & ' : /^(i|hi)/i.test(last) ? ' e ' : ' y ';
  return names.slice(0, -1).join(', ') + and + last;
};

// Reminder emails to households that have an email address and have not replied.
api.post(
  '/reminders',
  wrap(async (req, res) => {
    const settings = await db.getSettings();
    const targets = (await allHouseholds()).filter((h) => !h.responded_at && h.email);
    if (req.body && req.body.preview) return res.json({ count: targets.length, emailConfigured: email.configured() });
    if (!email.configured()) return res.status(400).json({ error: 'email_not_configured' });
    if (db.isLocked(settings)) return res.status(400).json({ error: 'locked' });
    const d = new Date(settings.rsvp_deadline + 'T12:00:00Z');
    let sent = 0;
    const failed = [];
    for (const h of targets) {
      const deadlineText = new Intl.DateTimeFormat(h.lang === 'es' ? 'es-ES' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
      const names = joinNames(h.guests.map((g) => g.name), h.lang);
      const m = email.reminder({ lang: h.lang, names, link: `${baseUrl(req)}/i/${h.token}`, deadlineText });
      const r = await email.send({ to: h.email, toName: names, ...m });
      if (r.ok) {
        sent++;
        await db.pool.query('UPDATE households SET reminded_at=now() WHERE id=$1', [h.id]);
      } else failed.push(names);
    }
    res.json({ ok: true, sent, failed });
  })
);

// ---------- Errors and start ----------

app.use((req, res) => res.status(404).send(LANDING));
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/admin/api') || req.path.startsWith('/api')) return res.status(500).json({ error: 'server_error' });
  res.status(500).send('Something went wrong. Please try again.');
});

const port = Number(process.env.PORT) || 3000;
db.init()
  .then(() => app.listen(port, () => console.log(`Listening on ${port}`)))
  .catch((e) => {
    console.error('Could not start', e);
    process.exit(1);
  });
