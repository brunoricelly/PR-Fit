#!/usr/bin/env node
// Benchmark do store json (adaptador de arquivo, db inteiro reescrito a cada save) vs postgres
// (saveMerged incremental). Gera um db sintetico realista, mede e APAGA tudo ao fim.
//
//   node scripts/bench-store.js --users 2000 --records 200000 [--backends json,postgres]
//        [--saves 200] [--writers 4] [--duration 20] [--phase-budget 240] [--min-free-mb 300]
//        [--tmp DIR] [--out resultado.json]
//
//   DATABASE_URL=postgres://user:pass@host:port/postgres   (so para o backend postgres; o script
//   cria um database descartavel bench_<pid>_<ts> e o remove ao fim)
//
// Medicoes (cada fase roda em PROCESSO proprio, para o RSS nao se misturar):
//   seed       gera e grava o db (json: saveDbUnlocked; pg: migrate + saveAll)
//   loadsave   carga a frio (loadDb / loadAll), RSS, e N saves de 1 mensagem nova (p50/p95/p99).
//              json: o saveDb do server (lock + loadDb + mergeDbCandidate + saveDbUnlocked) e, em
//              separado, so o saveDbUnlocked. pg: saveMerged(pool, base, candidate).
//   writers    K processos escrevendo em colecoes distintas por D segundos (throughput).
// Salvaguarda de disco: aborta se o livre cair abaixo de --min-free-mb; no json estima o pico
// transiente de um save (db.json, .bak, .txn.old/.new, .next, .bak.next ~ 6,5x o texto) ANTES de salvar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const num = (n, d) => Number(opt(n, d));
const role = opt('role', 'orchestrator');
const MB = 1024 * 1024;
const MIN_FREE = num('min-free-mb', 300) * MB;
const freeBytes = dir => { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };
class DiskGuardError extends Error { constructor(m) { super(m); this.name = 'DiskGuardError'; } }
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)].toFixed(2); };
const stats = xs => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? +Math.max(...xs).toFixed(2) : null });
const now = () => Number(process.hrtime.bigint()) / 1e6;
const rssMb = () => +(process.memoryUsage().rss / MB).toFixed(0);
const maxRssMb = () => +(process.resourceUsage().maxRSS / 1024).toFixed(0);

// ---------------------------------------------------------------- db sintetico
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pad = (n, w = 7) => String(n).padStart(w, '0');
const WORDS = 'treino ficou otimo hoje mais uma serie carga subiu dieta refeicao almoco jantar agua sono cansado dor joelho ombro cardio descanso semana meta peso proxima avaliacao foto ajuste proteina combinado perfeito obrigado bora'.split(' ');

export function generateDb({ users: nUsers, records, seed = 7 }) {
  const r = rng(seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const sentence = n => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const iso = i => new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
  const nCoaches = Math.max(1, Math.ceil(nUsers * 0.05));
  const users = [], creds = [], links = [], invites = [];
  for (let i = 0; i < nUsers; i++) {
    const coach = i < nCoaches;
    const id = `u_${pad(i)}`;
    users.push({ id, email: `user${i}@example.test`, name: `Usuario ${i}`, role: coach ? 'coach' : 'athlete', locale: 'pt-BR', createdAt: iso(i), onboarded: true, units: 'metric', goal: pick(['hipertrofia', 'emagrecimento', 'condicionamento']) });
    creds.push({ id: `c_${pad(i)}`, userId: id, type: 'password', hash: 'scrypt$' + Math.floor(r() * 1e15).toString(36).repeat(8).slice(0, 64), salt: Math.floor(r() * 1e15).toString(36).repeat(4).slice(0, 24), createdAt: iso(i) });
  }
  const linkOf = [];
  for (let i = nCoaches; i < nUsers; i++) {
    const coachIdx = (i - nCoaches) % nCoaches;
    const l = { id: `l_${pad(i)}`, coachId: `u_${pad(coachIdx)}`, athleteId: `u_${pad(i)}`, state: 'active', createdAt: iso(i), acceptedAt: iso(i + 5) };
    links.push(l); linkOf.push(l);
    if (r() < 0.1) invites.push({ id: `i_${pad(i)}`, linkId: l.id, coachId: l.coachId, tokenHash: 'h' + pad(i, 40), state: 'accepted', createdAt: iso(i) });
  }
  const athletes = linkOf.length ? linkOf : [{ id: 'l_0', coachId: 'u_0000000', athleteId: 'u_0000000' }];
  const W = { coachMessages: .30, mealAdherence: .25, habitCheckins: .20, coachPrescriptions: .10, mealPlans: .10, coachAssessments: .05 };
  const coll = Object.fromEntries(Object.keys(W).map(k => [k, []]));
  const counts = Object.fromEntries(Object.entries(W).map(([k, w]) => [k, Math.round(records * w)]));
  for (let i = 0; i < counts.coachMessages; i++) {
    const l = pick(athletes); const fromCoach = r() < 0.5;
    coll.coachMessages.push({ id: `m_${pad(i, 8)}`, linkId: l.id, coachId: l.coachId, athleteId: l.athleteId, from: fromCoach ? 'coach' : 'athlete', text: sentence(8 + Math.floor(r() * 24)), createdAt: iso(i), readAt: r() < .8 ? iso(i + 3) : null });
  }
  for (let i = 0; i < counts.mealPlans; i++) {
    const l = pick(athletes);
    coll.mealPlans.push({ id: `mp_${pad(i, 8)}`, athleteId: l.athleteId, coachId: l.coachId, name: 'Plano ' + sentence(2), kcal: 1800 + Math.floor(r() * 1200),
      meals: Array.from({ length: 4 }, (_, m) => ({ id: `meal_${m}`, name: ['Cafe', 'Almoco', 'Lanche', 'Jantar'][m], items: Array.from({ length: 3 }, (_, k) => ({ id: `it_${k}`, name: sentence(2), portion: `${50 + Math.floor(r() * 200)} g`, kcal: Math.floor(r() * 400), p: Math.floor(r() * 40), c: Math.floor(r() * 60), f: Math.floor(r() * 25) })) })), createdAt: iso(i) });
  }
  for (let i = 0; i < counts.mealAdherence; i++) {
    const l = pick(athletes);
    coll.mealAdherence.push({ id: `ma_${pad(i, 8)}`, athleteId: l.athleteId, planId: `mp_${pad(Math.floor(r() * Math.max(1, counts.mealPlans)), 8)}`, date: iso(i).slice(0, 10), meals: Array.from({ length: 4 }, (_, m) => ({ mealId: `meal_${m}`, status: pick(['done', 'done', 'partial', 'skipped']), kcal: Math.floor(r() * 700) })), updatedAt: iso(i) });
  }
  for (let i = 0; i < counts.habitCheckins; i++) {
    const l = pick(athletes);
    coll.habitCheckins.push({ id: `hc_${pad(i, 8)}`, athleteId: l.athleteId, habit: pick(['agua', 'sono', 'passos', 'proteina', 'alongamento']), date: iso(i).slice(0, 10), done: r() < .7, value: Math.floor(r() * 100), note: r() < .2 ? sentence(6) : '' });
  }
  for (let i = 0; i < counts.coachPrescriptions; i++) {
    const l = pick(athletes);
    coll.coachPrescriptions.push({ id: `rx_${pad(i, 8)}`, athleteId: l.athleteId, coachId: l.coachId, title: 'Treino ' + sentence(2), state: pick(['active', 'active', 'withdrawn']), createdAt: iso(i), updatedAt: iso(i + 9),
      routine: { days: Array.from({ length: 4 }, (_, d) => ({ name: `Dia ${d + 1}`, exercises: Array.from({ length: 6 }, (_, e) => ({ exerciseId: `ex_${Math.floor(r() * 800)}`, sets: 3 + Math.floor(r() * 2), reps: `${8 + Math.floor(r() * 5)}-${12 + Math.floor(r() * 4)}`, restSec: 60 + 30 * Math.floor(r() * 3), note: r() < .3 ? sentence(5) : '' })) })) } });
  }
  for (let i = 0; i < counts.coachAssessments; i++) {
    const l = pick(athletes);
    coll.coachAssessments.push({ id: `as_${pad(i, 8)}`, athleteId: l.athleteId, coachId: l.coachId, date: iso(i).slice(0, 10), weightKg: +(55 + r() * 50).toFixed(1), bodyFatPct: +(8 + r() * 25).toFixed(1), waistCm: +(65 + r() * 40).toFixed(1), photoOwnerId: l.athleteId, notes: sentence(14) });
  }
  const subs = Array.from({ length: Math.min(500, Math.ceil(nUsers / 4)) }, (_, i) => ({ endpoint: `https://push.example.test/send/${pad(i)}`, userId: `u_${pad(i)}`, keys: { p256dh: 'k'.repeat(87), auth: 'a'.repeat(22) } }));
  return { schemaVersion: 9, b2b2cMigrated: true, users, creds, subs, invites: [], coachAthleteLinks: links, coachInvites: invites, ...coll };
}
const totalRows = db => Object.values(db).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
const WRITER_KEYS = ['coachMessages', 'mealAdherence', 'habitCheckins', 'coachAssessments'];
const writerKey = i => WRITER_KEYS[i] ?? `benchExtra${i}`;
const newRow = (key, tag, n) => ({ id: `${tag}_${n}`, linkId: 'l_bench', coachId: 'u_0000000', athleteId: 'u_0000001', from: 'athlete', text: 'mensagem sintetica do benchmark numero ' + n, createdAt: new Date().toISOString(), readAt: null });

// ---------------------------------------------------------------- acesso aos backends
const lockOptions = { leaseMs: 30_000, acquireTimeoutMs: 5_000, retryMs: 10 }; // = server.js (reminder defaults)
async function jsonStore(dataDir) {
  process.env.STORE = 'json';
  const { createStore } = await import(pathToFileURL(path.join(API, 'store/index.js')).href);
  return createStore({ dataDir, lockOptions });
}
async function pgModules() {
  const pg = (await import(pathToFileURL(path.join(API, 'node_modules/pg/lib/index.js')).href)).default;
  const store = await import(pathToFileURL(path.join(API, 'store/pg-store.js')).href);
  const mig = await import(pathToFileURL(path.join(API, 'store/migrate.js')).href);
  return { pg, ...store, migrate: mig.migrate };
}
const coord = () => import(pathToFileURL(path.join(API, 'db-coordinator.js')).href);
const jsonSizes = dir => { const sz = f => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } }; const a = sz('db.json'), b = sz('db.json.bak'); return { dbJsonMb: +(a / MB).toFixed(1), bakMb: +(b / MB).toFixed(1), totalMb: +((a + b) / MB).toFixed(1), bytes: a }; };
async function pgSizes(pool) {
  const t = (await pool.query(`SELECT c.relname, pg_total_relation_size(c.oid)::bigint AS b FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY b DESC`)).rows;
  const total = t.reduce((s, r) => s + Number(r.b), 0);
  const dbsz = Number((await pool.query('SELECT pg_database_size(current_database()) AS b')).rows[0].b);
  return { tablesMb: +(total / MB).toFixed(1), databaseMb: +(dbsz / MB).toFixed(1), byTable: Object.fromEntries(t.map(r => [r.relname, +(Number(r.b) / MB).toFixed(1)])) };
}
function guardJson(dir, textBytes) {
  const free = freeBytes(dir);
  if (free - 6.5 * textBytes < MIN_FREE) throw new DiskGuardError(`pico estimado de ${(6.5 * textBytes / MB).toFixed(0)} MB (6,5 x ${(textBytes / MB).toFixed(1)} MB) deixaria < ${MIN_FREE / MB} MB livres (livre agora: ${(free / MB).toFixed(0)} MB)`);
}

// ---------------------------------------------------------------- fases (processos filhos)
const send = msg => process.send ? process.send(msg) : console.log(JSON.stringify(msg));
async function phaseSeed() {
  const backend = opt('backend'); const dir = opt('dir'); const t0 = now();
  const db = generateDb({ users: num('users', 2000), records: num('records', 200000) });
  const genMs = now() - t0; const rows = totalRows(db);
  if (backend === 'json') {
    const textBytes = Buffer.byteLength(JSON.stringify(db, null, 2));
    guardJson(dir, textBytes);
    const store = await jsonStore(dir);
    const t1 = now(); store.lock.withLockSync(() => store.saveDbUnlocked(db));
    send({ ok: true, rows, genMs: +genMs.toFixed(0), seedMs: +(now() - t1).toFixed(0), sizes: jsonSizes(dir), maxRssMb: maxRssMb(), freeMb: +(freeBytes(dir) / MB).toFixed(0) });
  } else {
    const { pg, saveAll, migrate } = await pgModules();
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      await migrate(pool);
      const t1 = now(); await saveAll(pool, db); const seedMs = now() - t1;
      await pool.query('VACUUM ANALYZE');
      send({ ok: true, rows, genMs: +genMs.toFixed(0), seedMs: +seedMs.toFixed(0), sizes: await pgSizes(pool), maxRssMb: maxRssMb() });
    } finally { await pool.end(); }
  }
}

async function phaseLoadSave() {
  const backend = opt('backend'); const dir = opt('dir'); const saves = num('saves', 200); const budgetMs = num('phase-budget', 240) * 1000;
  const lat = [], latIo = []; let aborted = null, load = {}, rssAfterLoad;
  const { mergeDbCandidate } = await coord();
  let db, persisted, doSave, closeFn = async () => {};
  if (backend === 'json') {
    const store = await jsonStore(dir);
    const times = []; for (let i = 0; i < 4; i++) { const t = now(); const d = store.loadDb(); times.push(now() - t); if (i === 0) db = d; }
    load = { coldMs: +times[0].toFixed(0), warmMedianMs: +pct(times.slice(1), 50).toFixed(0), what: 'loadDb() (1a = processo frio)' };
    const textBytes = jsonSizes(dir).bytes;
    doSave = () => {
      guardJson(dir, textBytes * 1.01);
      const t0 = now(); let tIo;
      store.lock.withLockSync(() => {
        const latest = store.loadDb(); const merged = mergeDbCandidate(latest, persisted, db);
        const t1 = now(); store.saveDbUnlocked(merged); tIo = now() - t1;
      });
      return [now() - t0, tIo];
    };
  } else {
    const { pg, loadAll, saveMerged } = await pgModules();
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    closeFn = () => pool.end();
    const times = []; for (let i = 0; i < 4; i++) { const t = now(); const d = await loadAll(pool); times.push(now() - t); if (i === 0) db = d; else if (i === 3) rssAfterLoad = null; }
    load = { coldMs: +times[0].toFixed(0), warmMedianMs: +pct(times.slice(1), 50).toFixed(0), what: 'loadAll(pool) (1a = processo frio)' };
    doSave = async () => { const t0 = now(); await saveMerged(pool, persisted, db); return [now() - t0, null]; };
  }
  persisted = structuredClone(db);
  rssAfterLoad = rssMb();
  const start = now();
  for (let i = 0; i < saves; i++) {
    db.coachMessages.push(newRow('coachMessages', 'bench', i));
    try {
      const [total, io] = await doSave();
      lat.push(total); if (io != null) latIo.push(io);
    } catch (e) { aborted = `${e.name}: ${e.message}`; break; }
    persisted = structuredClone(db); // fora do cronometro: e o persistedDb do server
    if (now() - start > budgetMs) { aborted = `orcamento de ${budgetMs / 1000}s da fase atingido apos ${lat.length} saves`; break; }
  }
  const out = { ok: true, load, rssAfterLoadMb: rssAfterLoad, maxRssMb: maxRssMb(), save: stats(lat), aborted };
  if (latIo.length) out.saveDbUnlockedOnly = stats(latIo);
  send(out); await closeFn();
}

async function phaseWriter() {
  const backend = opt('backend'); const dir = opt('dir'); const idx = num('idx', 0); const key = writerKey(idx);
  const lat = []; let errors = 0, firstError = null, aborted = null, n = 0, base, save;
  const { mergeDbCandidate } = await coord();
  let closeFn = async () => {};
  if (backend === 'json') {
    const store = await jsonStore(dir);
    save = row => {
      guardJson(dir, jsonSizes(dir).bytes * 1.01);
      store.lock.withLockSync(() => { const latest = store.loadDb(); (latest[key] ||= []).push(row); store.saveDbUnlocked(latest); });
    };
  } else {
    const { pg, saveMerged } = await pgModules();
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); closeFn = () => pool.end();
    // So a propria colecao: cada writer toca uma chave distinta (sem ConcurrentDbWriteError); o custo
    // dentro da transacao (loadAll + merge + diff do db inteiro) e o mesmo de um base completo.
    base = { [key]: (await pool.query('SELECT data FROM collections WHERE collection = $1 ORDER BY seq', [key])).rows.map(r => r.data) };
    save = async row => {
      const candidate = { [key]: [...base[key], row] };
      const merged = await saveMerged(pool, base, candidate);
      base = { [key]: merged[key] };
    };
  }
  process.send({ type: 'ready' });
  await new Promise(res => process.once('message', m => m === 'go' && res()));
  const end = Date.now() + num('duration', 20) * 1000;
  while (Date.now() < end) {
    const t = now();
    try { await save(newRow(key, `w${idx}`, n++)); lat.push(now() - t); }
    catch (e) {
      if (e.name === 'DiskGuardError') { aborted = e.message; break; }
      errors++; firstError ||= `${e.name}: ${e.message}`;
      if (errors > 50) { aborted = 'mais de 50 erros: ' + firstError; break; }
    }
  }
  process.send({ type: 'result', idx, key, saves: lat.length, errors, firstError, aborted, latencies: lat, maxRssMb: maxRssMb() });
  await closeFn();
}

if (role === 'seed') await phaseSeed().then(() => process.exit(0));
else if (role === 'loadsave') await phaseLoadSave().then(() => process.exit(0));
else if (role === 'writer') await phaseWriter().then(() => process.exit(0));
else await orchestrate();

// ---------------------------------------------------------------- orquestrador
function runPhase(name, extra, { timeoutMs = 900_000 } = {}) {
  return new Promise(resolve => {
    const child = fork(fileURLToPath(import.meta.url), ['--role', name, ...extra], { execArgv: ['--max-old-space-size=1400'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let result = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('message', m => { if (m && m.ok !== undefined) result = m; });
    child.on('exit', (code, sig) => { clearTimeout(timer); resolve(result ?? { ok: false, error: `fase ${name} terminou sem resultado (code=${code} signal=${sig})` }); });
  });
}

const memAvailMb = () => { try { return Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024; } catch { return Infinity; } };

// perWriterMb: estimativa de memoria de cada writer (json: ~5x o texto do db, pois cada save le e
// serializa o db inteiro). Se a memoria disponivel nao comporta os K writers pedidos, reduz K e REGISTRA.
async function runWriters(backendArgs, requested, duration, perWriterMb) {
  const kids = []; const results = [];
  const avail = memAvailMb();
  const k = Math.min(requested, Math.floor(avail * 0.7 / perWriterMb));
  if (k < 1) return { error: `memoria disponivel (${avail.toFixed(0)} MB) nao comporta nem 1 writer (~${perWriterMb.toFixed(0)} MB): fase nao medida`, writersRequested: requested };
  const reduced = k < requested ? { writersRequested: requested, note: `reduzido de ${requested} para ${k} writers por falta de memoria (MemAvailable ${avail.toFixed(0)} MB, ~${perWriterMb.toFixed(0)} MB/writer)` } : {};
  for (let i = 0; i < k; i++) {
    const child = fork(fileURLToPath(import.meta.url), ['--role', 'writer', '--idx', String(i), '--duration', String(duration), ...backendArgs], { execArgv: ['--max-old-space-size=700'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const rec = { child, ready: null, done: null };
    rec.ready = new Promise(res => child.on('message', m => { if (m.type === 'ready') res(true); }));
    rec.done = new Promise(res => { let got = null; child.on('message', m => { if (m.type === 'result') got = m; }); child.on('exit', (code, sig) => res(got ?? { crashed: `code=${code} signal=${sig}` })); });
    kids.push(rec);
  }
  const ready = await Promise.race([Promise.all(kids.map(k2 => k2.ready)), new Promise(res => setTimeout(() => res(false), 180_000))]);
  if (!ready) { for (const k2 of kids) k2.child.kill('SIGKILL'); return { error: 'writers nao ficaram prontos em 180s (memoria/CPU?)' }; }
  const t0 = Date.now(); for (const k2 of kids) k2.child.send('go');
  for (const k2 of kids) results.push(await k2.done);
  const wall = (Date.now() - t0) / 1000;
  const good = results.filter(r => !r.crashed);
  const all = good.flatMap(r => r.latencies);
  return { ...reduced, writers: k, wallS: +wall.toFixed(1), totalSaves: good.reduce((s, r) => s + r.saves, 0), savesPerSec: +(good.reduce((s, r) => s + r.saves, 0) / duration).toFixed(2),
    errors: good.reduce((s, r) => s + r.errors, 0), firstError: good.find(r => r.firstError)?.firstError ?? null, aborted: good.map(r => r.aborted).filter(Boolean)[0] ?? null,
    crashed: results.filter(r => r.crashed).map(r => r.crashed), perWriterSaves: good.map(r => r.saves), latencyMs: stats(all), maxWriterRssMb: Math.max(0, ...good.map(r => r.maxRssMb)) };
}

async function orchestrate() {
  const users = num('users', 2000), records = num('records', 200000), saves = num('saves', 200), writers = num('writers', 4), duration = num('duration', 20);
  const backends = opt('backends', 'json,postgres').split(',');
  const tmpRoot = opt('tmp', process.env.TMPDIR || os.tmpdir());
  const run = path.join(tmpRoot, `bench-store-${process.pid}`);
  const report = { when: new Date().toISOString(), node: process.version, host: { cpus: os.cpus().length, memMb: Math.round(os.totalmem() / MB) }, users, records, saves, writers, duration, results: {} };
  let adminPool = null, dbName = null, pgUrl = null; const pgMods = backends.includes('postgres') ? await pgModules() : null;
  const cleanup = async () => {
    fs.rmSync(run, { recursive: true, force: true });
    if (adminPool && dbName) { await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(e => console.error('drop falhou:', e.message)); await adminPool.end().catch(() => {}); adminPool = null; }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(130); });
  try {
    fs.mkdirSync(run, { recursive: true });
    if (freeBytes(run) < MIN_FREE) throw new DiskGuardError(`livre ${(freeBytes(run) / MB).toFixed(0)} MB < ${MIN_FREE / MB} MB: abortado`);
    for (const backend of backends) {
      const res = report.results[backend] = {};
      const dir = path.join(run, backend); fs.mkdirSync(dir, { recursive: true });
      let extra = ['--backend', backend, '--dir', dir, '--users', String(users), '--records', String(records), '--saves', String(saves), '--phase-budget', opt('phase-budget', '240'), '--min-free-mb', String(MIN_FREE / MB)];
      if (backend === 'postgres') {
        if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL e obrigatoria para o backend postgres');
        adminPool = new pgMods.pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
        dbName = `bench_${process.pid}_${Date.now()}`;
        await adminPool.query(`CREATE DATABASE ${dbName}`);
        const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + dbName; pgUrl = u.toString();
        process.env.DATABASE_URL_BENCH = pgUrl;
      }
      const env = backend === 'postgres' ? { DATABASE_URL: pgUrl } : {};
      Object.assign(process.env, env);
      const label = `[${backend}]`;
      console.log(`${label} seed users=${users} records=${records} ...`);
      res.seed = await runPhase('seed', extra); console.log(label, 'seed:', JSON.stringify(res.seed));
      if (!res.seed.ok) { if (backend === 'json') { fs.rmSync(dir, { recursive: true, force: true }); } continue; }
      console.log(`${label} loadsave (${saves} saves) ...`);
      res.loadSave = await runPhase('loadsave', extra); console.log(label, 'loadsave:', JSON.stringify(res.loadSave));
      if (res.loadSave.ok) {
        console.log(`${label} ${writers} writers x ${duration}s ...`);
        res.concurrent = await runWriters(extra, writers, duration, backend === 'json' ? Math.max(60, 5 * (res.seed.sizes.bytes / MB)) : 90); console.log(label, 'writers:', JSON.stringify({ ...res.concurrent, latencies: undefined }));
      }
      if (backend === 'postgres') { const pool = new pgMods.pg.Pool({ connectionString: pgUrl, max: 1 }); res.sizeAfter = await pgSizes(pool); await pool.end(); }
      else res.sizeAfter = jsonSizes(dir);
      res.freeMbAfter = +(freeBytes(run) / MB).toFixed(0);
      if (backend === 'json') fs.rmSync(dir, { recursive: true, force: true }); // libera disco antes do proximo backend
    }
  } catch (e) { report.error = `${e.name}: ${e.message}`; console.error('ERRO:', report.error); }
  finally { await cleanup(); }
  report.cleanedUp = !fs.existsSync(run);
  const o = opt('out'); if (o) fs.writeFileSync(o, JSON.stringify(report, null, 2));
  console.log('\n=== RESULTADO (JSON) ===\n' + JSON.stringify(report, null, 2));
  process.exit(report.error ? 1 : 0);
}
