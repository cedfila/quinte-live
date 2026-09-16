require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PMU_BASE = 'https://online.turfinfo.api.pmu.fr/rest/client/1/programme';
const REFRESH_SECONDS = Number(process.env.REFRESH_SECONDS || 30);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Indian/Reunion';
const DAY_START_HOUR = Number(process.env.DAY_START_HOUR || 7);
const HISTORY_HOURS = 48;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PRONOSTICS_FILE = path.join(DATA_DIR, 'pronostics.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DONATION_URL = process.env.DONATION_URL || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: APP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(x => [x.type, x.value]));
}

function addDays(iso, amount) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function appNow() {
  const p = zonedParts();
  return { ...p, isoDate: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

// The daily cycle starts at 07:00 in APP_TIMEZONE. Before 07:00, the previous day's result remains the main display.
function cycleDate() {
  const n = appNow();
  return n.hour < DAY_START_HOUR ? addDays(n.isoDate, -1) : n.isoDate;
}

function pmuDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}${m}${y}`;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'QuinteLive/2.0' } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Réponse non JSON (${r.status})`); }
  if (!r.ok) throw new Error(data?.message || `PMU HTTP ${r.status}`);
  return data;
}

function walk(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const x of value) walk(x, out); return out; }
  out.push(value);
  for (const v of Object.values(value)) walk(v, out);
  return out;
}

function textOf(o) { return Object.values(o || {}).filter(v => typeof v === 'string').join(' ').toUpperCase(); }
function looksLikeQuinte(o) {
  const t = textOf(o);
  return t.includes('QUINTE') || t.includes('QUINTÉ') || (t.includes('PRIX DES') && (t.includes('16 PARTANTS') || t.includes('15 PARTANTS')));
}
function findCourseInProgram(program) {
  const candidates = walk(program).filter(looksLikeQuinte);
  for (const o of candidates) {
    const r = o.numReunion ?? o.numeroReunion ?? o.reunion ?? o.numR;
    const c = o.numCourse ?? o.numeroCourse ?? o.course ?? o.numC;
    if (Number.isFinite(Number(r)) && Number.isFinite(Number(c))) return { r: Number(r), c: Number(c), raw: o };
  }
  return null;
}
function firstArrayDeep(x, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  for (const o of walk(x)) for (const [k, v] of Object.entries(o)) if (wanted.has(k.toLowerCase()) && Array.isArray(v)) return v;
  return [];
}
function firstValueDeep(x, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  for (const o of walk(x)) for (const [k, v] of Object.entries(o)) if (wanted.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return v;
  return '';
}
function valueForObject(o, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  for (const obj of walk(o)) for (const [k, v] of Object.entries(obj)) if (wanted.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return v;
  return '';
}
function normalizeParticipants(data) {
  const arr = firstArrayDeep(data, ['participants', 'partants']);
  return arr.map((p, index) => ({
    number: String(p?.numPmu ?? p?.numero ?? p?.num ?? index + 1),
    name: String(p?.nom ?? p?.nomCheval ?? p?.cheval?.nom ?? p?.participant?.nom ?? `N° ${p?.numPmu ?? index + 1}`),
    order: Number(p?.ordreArrivee ?? p?.ordreArriveeOfficiel ?? p?.ordre ?? p?.place ?? 0) || 0,
    odds: valueForObject(p, ['cote', 'coteDirect', 'coteReference', 'rapportProbable', 'dernierRapport', 'rapport']) || ''
  })).filter(x => x.number);
}
function normalizeReports(data) {
  const root = data?.listeRapports ?? data?.rapports ?? data;
  const result = {};
  for (const o of walk(root)) {
    const name = String(o?.typePari ?? o?.libelle ?? o?.pari ?? o?.type ?? '');
    const amount = o?.rapport ?? o?.montant ?? o?.gain ?? o?.dividende;
    if (name && amount !== undefined && amount !== null) result[name] = amount;
  }
  return result;
}

function ensureHistory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]', 'utf8');
  if (!fs.existsSync(PRONOSTICS_FILE)) fs.writeFileSync(PRONOSTICS_FILE, '[]', 'utf8');
}
function readPronostics() {
  ensureHistory();
  try { return JSON.parse(fs.readFileSync(PRONOSTICS_FILE, 'utf8')) || []; } catch { return []; }
}
function writePronostics(items) {
  ensureHistory();
  fs.writeFileSync(PRONOSTICS_FILE, JSON.stringify(items, null, 2), 'utf8');
}
function checkAdmin(req, res) {
  if (!ADMIN_PASSWORD) { res.status(503).json({ error: 'ADMIN_PASSWORD non configuré dans .env' }); return false; }
  const supplied = req.get('x-admin-password') || req.body?.password || '';
  if (supplied !== ADMIN_PASSWORD) { res.status(401).json({ error: 'Mot de passe administrateur incorrect' }); return false; }
  return true;
}
function readHistory() {
  ensureHistory();
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || []; } catch { return []; }
}
function writeHistory(items) {
  ensureHistory();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}
function pruneHistory() {
  const cutoff = Date.now() - HISTORY_HOURS * 60 * 60 * 1000;
  const kept = readHistory().filter(x => new Date(x.savedAt || x.updatedAt || 0).getTime() >= cutoff);
  writeHistory(kept);
  return kept;
}
function saveResult(result) {
  const history = pruneHistory();
  const key = `${result.date}|${result.course}`;
  const index = history.findIndex(x => `${x.date}|${x.course}` === key);
  const saved = { ...result, savedAt: index >= 0 ? history[index].savedAt : new Date().toISOString() };
  if (index >= 0) history[index] = saved; else history.unshift(saved);
  writeHistory(history);
  return saved;
}

let discoveryCache = new Map();
async function discoverQuinte(dateIso) {
  const cached = discoveryCache.get(dateIso);
  if (cached && cached.expires > Date.now()) return cached.value;
  const date = pmuDate(dateIso);
  try {
    const program = await getJSON(`${PMU_BASE}/${date}`);
    const found = findCourseInProgram(program);
    if (found) {
      discoveryCache.set(dateIso, { value: found, expires: Date.now() + 10 * 60 * 1000 });
      return found;
    }
  } catch (_) {}
  const fallback = { r: 1, c: 1 };
  discoveryCache.set(dateIso, { value: fallback, expires: Date.now() + 10 * 60 * 1000 });
  return fallback;
}

async function fetchRace(date) {
  const { r, c } = await discoverQuinte(date);
  const base = `${PMU_BASE}/${pmuDate(date)}/R${r}/C${c}`;
  const [course, participants, reports] = await Promise.allSettled([
    getJSON(base),
    getJSON(`${base}/participants`),
    getJSON(`${base}/rapports-definitifs?combinaisonEnTableau=true&specialisation=INTERNET`)
  ]);
  if (course.status === 'rejected' && participants.status === 'rejected') throw new Error(course.reason?.message || participants.reason?.message || 'Données PMU indisponibles');
  const cdata = course.status === 'fulfilled' ? course.value : {};
  const pdata = participants.status === 'fulfilled' ? participants.value : {};
  const rdata = reports.status === 'fulfilled' ? reports.value : {};
  const runners = normalizeParticipants(pdata);
  const arrival = runners.filter(x => x.order > 0).sort((a, b) => a.order - b.order).slice(0, 5);
  const details = {
    distance: firstValueDeep(cdata, ['distance', 'distanceCourse', 'distanceMetres']),
    allocation: firstValueDeep(cdata, ['allocation', 'allocationTotale']),
    discipline: firstValueDeep(cdata, ['discipline', 'typeCourse']),
    terrain: firstValueDeep(cdata, ['etatPiste', 'terrain', 'etatTerrain']),
    corde: firstValueDeep(cdata, ['corde', 'cordeCourse']),
    nombrePartants: runners.length || firstValueDeep(cdata, ['nombrePartants', 'nbPartants'])
  };
  return {
    date,
    hippodrome: String(firstValueDeep(cdata, ['hippodrome', 'nomHippodrome', 'lieu']) || ''),
    course: `R${r}C${c}`,
    nomCourse: String(firstValueDeep(cdata, ['libelle', 'nomCourse', 'nom', 'prix', 'libelleCourse']) || 'Quinté+'),
    heure: String(firstValueDeep(cdata, ['heureDepart', 'heure', 'heureDepartPrevue']) || ''),
    statut: arrival.length >= 5 ? 'Arrivée officielle publiée' : 'Course du jour — résultats en attente',
    mode: arrival.length >= 5 ? 'result' : 'race',
    arrival,
    participants: runners,
    reports: normalizeReports(rdata),
    details,
    updatedAt: new Date().toISOString(),
    source: 'PMU / turfinfo.api.pmu.fr',
    refreshSeconds: REFRESH_SECONDS
  };
}

app.get('/api/quinte', async (req, res) => {
  const date = cycleDate();
  try {
    const race = await fetchRace(date);
    let current = race;
    if (race.mode === 'result') current = saveResult(race);
    const history = pruneHistory();
    res.json({ ...current, cycleDate: date, timezone: APP_TIMEZONE, dayStartHour: DAY_START_HOUR, history: history.slice(0, 10) });
  } catch (e) {
    const history = pruneHistory();
    const previous = history.find(x => x.date === date);
    if (previous) return res.json({ ...previous, mode: 'result', cycleDate: date, timezone: APP_TIMEZONE, dayStartHour: DAY_START_HOUR, history: history.slice(0, 10), fallback: true });
    res.status(502).json({ error: e.message, source: 'PMU / turfinfo.api.pmu.fr' });
  }
});

app.get('/api/history', (req, res) => res.json({ history: pruneHistory().slice(0, 10), retentionHours: HISTORY_HOURS }));
app.get('/api/pronostics', (req, res) => {
  const current = cycleDate();
  const stored = readPronostics();
  const items = stored.filter(x => !x.cycleDate || x.cycleDate === current);
  if (items.length !== stored.length) writePronostics(items);
  res.json({ pronostics: items });
});
app.get('/api/config', (req, res) => res.json({ donationUrl: DONATION_URL }));
app.post('/api/pronostics', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const body = req.body || {};
  const title = String(body.title || '').trim();
  const selection = String(body.selection || '').trim();
  const comment = String(body.comment || '').trim();
  if (!title || !selection) return res.status(400).json({ error: 'Le titre et le pronostic sont obligatoires.' });
  const item = { id: Date.now().toString(), title, selection, comment, cycleDate: cycleDate(), createdAt: new Date().toISOString() };
  // Un seul pronostic actif : une nouvelle publication remplace automatiquement l'ancien.
  writePronostics([item]);
  res.json({ ok: true, pronostic: item });
});
app.delete('/api/pronostics/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const items = readPronostics().filter(x => x.id !== req.params.id);
  writePronostics(items);
  res.json({ ok: true });
});
app.get('/api/health', (req, res) => res.json({ ok: true, source: 'PMU', refreshSeconds: REFRESH_SECONDS, timezone: APP_TIMEZONE, dayStartHour: DAY_START_HOUR, retentionHours: HISTORY_HOURS }));
app.get('*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Background polling: official results are detected and saved even if no visitor has the page open.
async function backgroundSync() {
  try {
    const date = cycleDate();
    const race = await fetchRace(date);
    if (race.mode === 'result') saveResult(race);
    pruneHistory();
  } catch (e) {
    console.error('Synchronisation PMU:', e.message);
  }
}

setInterval(backgroundSync, REFRESH_SECONDS * 1000);
setInterval(() => { try { pruneHistory(); } catch (e) { console.error('Historique:', e.message); } }, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Quinté Live PMU lancé sur http://localhost:${PORT} — cycle ${DAY_START_HOUR}h (${APP_TIMEZONE})`);
  backgroundSync();
});
