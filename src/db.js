// Database access and schema. The schema is created on start if it is missing.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const useSsl = !/localhost|127\.0\.0\.1|\/var\/run|host=\//.test(connectionString) && process.env.PGSSL !== 'off';
const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS households (
  id            SERIAL PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL CHECK (type IN ('day','eve')),
  lang          TEXT NOT NULL CHECK (lang IN ('en','es')),
  whatsapp      TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  message_at    TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  opened_at     TIMESTAMPTZ,
  responded_at  TIMESTAMPTZ,
  reminded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guests (
  id            SERIAL PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  attending     BOOLEAN,
  meal          TEXT CHECK (meal IN ('meat','veg','vegan')),
  diet          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS guests_household_idx ON guests(household_id);
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  rsvp_deadline: '2027-05-31',
  rsvp_locked: 'no',
  wa_en: "Hi {names}! We're getting married and would love you to be there. Here is your personal invitation, with all the details and your RSVP: {link}\n\nFiorella & David",
  wa_es: '¡Hola {names}! Nos casamos y nos encantaría que nos acompañen. Aquí está su invitación personal, con todos los detalles y la confirmación de asistencia: {link}\n\nFiorella y David',
};

const DEFAULT_ADMINS = [
  { email: 'david.cox.gt@gmail.com', name: 'Dave' },
  { email: 'fiorella.lamattarom@gmail.com', name: 'Fio' },
];

async function init() {
  await pool.query(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  for (const a of DEFAULT_ADMINS) {
    await pool.query('INSERT INTO admins(email,name) VALUES($1,$2) ON CONFLICT (email) DO NOTHING', [a.email, a.name]);
  }
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key,value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [key, value]
  );
}

// RSVPs close at the end of the deadline day in UK time, or as soon as an admin locks them.
function isLocked(settings, now = new Date()) {
  if (settings.rsvp_locked === 'yes') return true;
  const ukDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now); // YYYY-MM-DD
  return ukDate > settings.rsvp_deadline;
}

module.exports = { pool, init, getSettings, setSetting, isLocked };
