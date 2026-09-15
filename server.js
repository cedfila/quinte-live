const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PMU_BASE = "https://online.turfinfo.api.pmu.fr/rest/client/1/programme";
const REFRESH_SECONDS = Number(process.env.REFRESH_SECONDS || 30);

app.use(express.static(path.join(__dirname, "public")));

function todayParis() {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function pmuDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}${m}${y}`;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "QuinteLive/1.0" } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Réponse non JSON (${r.status})`); }
  if (!r.ok) throw new Error(data?.message || `PMU HTTP ${r.status}`);
  return data;
}

function walk(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const x of value) walk(x, out); return out; }
  out.push(value);
  for (const v of Object.values(value)) walk(v, out);
  return out;
}

function textOf(o) {
  return Object.values(o || {}).filter(v => typeof v === "string").join(" ").toUpperCase();
}

function looksLikeQuinte(o) {
  const t = textOf(o);
  return t.includes("QUINTE") || t.includes("QUINTÉ") || t.includes("PRIX DES") && (t.includes("16 PARTANTS") || t.includes("15 PARTANTS"));
}

function findCourseInProgram(program) {
  const objs = walk(program);
  const candidates = objs.filter(o => looksLikeQuinte(o));
  for (const o of candidates) {
    const r = o.numReunion ?? o.numeroReunion ?? o.reunion ?? o.numR;
    const c = o.numCourse ?? o.numeroCourse ?? o.course ?? o.numC;
    if (Number.isFinite(Number(r)) && Number.isFinite(Number(c))) return { r: Number(r), c: Number(c), raw: o };
  }
  return null;
}

function findCourseCode(o) {
  const r = o?.numReunion ?? o?.numeroReunion ?? o?.reunion ?? o?.numR;
  const c = o?.numCourse ?? o?.numeroCourse ?? o?.course ?? o?.numC;
  if (Number.isFinite(Number(r)) && Number.isFinite(Number(c))) return { r: Number(r), c: Number(c) };
  return null;
}

function firstArrayDeep(x, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  for (const o of walk(x)) {
    for (const [k, v] of Object.entries(o)) {
      if (wanted.has(k.toLowerCase()) && Array.isArray(v)) return v;
    }
  }
  return [];
}

function firstValueDeep(x, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  for (const o of walk(x)) {
    for (const [k, v] of Object.entries(o)) {
      if (wanted.has(k.toLowerCase()) && (typeof v === "string" || typeof v === "number")) return v;
    }
  }
  return "";
}

function normalizeParticipants(data) {
  const arr = firstArrayDeep(data, ["participants", "partants"]);
  return arr.map((p, index) => ({
    number: String(p?.numPmu ?? p?.numero ?? p?.num ?? index + 1),
    name: String(p?.nom ?? p?.nomCheval ?? p?.cheval?.nom ?? p?.participant?.nom ?? `N° ${p?.numPmu ?? index + 1}`),
    order: Number(p?.ordreArrivee ?? p?.ordreArriveeOfficiel ?? p?.ordre ?? p?.place ?? 0) || 0
  })).filter(x => x.number);
}

function normalizeReports(data) {
  const root = data?.listeRapports ?? data?.rapports ?? data;
  const result = {};
  for (const o of walk(root)) {
    const name = String(o?.typePari ?? o?.libelle ?? o?.pari ?? o?.type ?? "");
    const amount = o?.rapport ?? o?.montant ?? o?.gain ?? o?.dividende;
    if (name && amount !== undefined && amount !== null) result[name] = amount;
  }
  return result;
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

  // The Quinté+ is normally R1C1. This fallback also keeps the page working
  // if PMU changes the shape of the daily program JSON.
  const fallback = { r: 1, c: 1 };
  discoveryCache.set(dateIso, { value: fallback, expires: Date.now() + 10 * 60 * 1000 });
  return fallback;
}

app.get("/api/quinte", async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : todayParis();
  try {
    const { r, c } = await discoverQuinte(date);
    const base = `${PMU_BASE}/${pmuDate(date)}/R${r}/C${c}`;
    const [course, participants, reports] = await Promise.allSettled([
      getJSON(base),
      getJSON(`${base}/participants`),
      getJSON(`${base}/rapports-definitifs?combinaisonEnTableau=true&specialisation=INTERNET`)
    ]);

    if (course.status === "rejected" && participants.status === "rejected") {
      throw new Error(course.reason?.message || participants.reason?.message || "Données PMU indisponibles");
    }

    const cdata = course.status === "fulfilled" ? course.value : {};
    const pdata = participants.status === "fulfilled" ? participants.value : {};
    const rdata = reports.status === "fulfilled" ? reports.value : {};
    const runners = normalizeParticipants(pdata);
    const arrival = runners.filter(x => x.order > 0).sort((a,b) => a.order - b.order).slice(0, 5);

    const title = firstValueDeep(cdata, ["libelle", "nomCourse", "nom", "prix", "libelleCourse"]);
    const venue = firstValueDeep(cdata, ["hippodrome", "nomHippodrome", "lieu"]);
    const heure = firstValueDeep(cdata, ["heureDepart", "heure", "heureDepartPrevue"]);

    res.json({
      date,
      hippodrome: String(venue || ""),
      course: `R${r}C${c}`,
      nomCourse: String(title || "Quinté+"),
      heure: String(heure || ""),
      statut: arrival.length >= 5 ? "Arrivée publiée" : "En attente de l’arrivée officielle",
      arrival,
      reports: normalizeReports(rdata),
      updatedAt: new Date().toISOString(),
      source: "PMU / turfinfo.api.pmu.fr",
      refreshSeconds: REFRESH_SECONDS
    });
  } catch (e) {
    res.status(502).json({ error: e.message, source: "PMU / turfinfo.api.pmu.fr" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, source: "PMU", refreshSeconds: REFRESH_SECONDS }));
app.get("*splat", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Quinté Live PMU lancé sur http://localhost:${PORT}`));
