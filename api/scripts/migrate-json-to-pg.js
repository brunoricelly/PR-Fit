#!/usr/bin/env node
// Imports DATA_DIR/db.json (+ state-<uid>.json profile docs) into PostgreSQL. Idempotent: re-running
// only writes what differs. Never modifies the JSON files.
//   node scripts/migrate-json-to-pg.js --data-dir /path/to/data [--dry-run]   (DATABASE_URL required unless --dry-run)
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../store/migrate.js';
import { loadAll, saveAll, importUserState, getUserState } from '../store/pg-store.js';
import { diffDb, canonicalize, findReferenceProblems } from '../store/diff.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = opt('--data-dir') || process.env.DATA_DIR;
const dryRun = flag('--dry-run');
if (!dataDir) { console.error('usage: migrate-json-to-pg.js --data-dir DIR [--dry-run]'); process.exit(2); }
if (!dryRun && !process.env.DATABASE_URL) { console.error('DATABASE_URL is required (or use --dry-run)'); process.exit(2); }

const dbFile = path.join(dataDir, 'db.json');
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('db.json is not an object');
const states = fs.readdirSync(dataDir).filter(f => /^state-.+\.json$/.test(f)).sort().map(f => ({
  uid: f.replace(/^state-/, '').replace(/\.json$/, ''), doc: JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')),
}));

const problems = findReferenceProblems(db);
const counts = {};
for (const [k, v] of Object.entries(db)) if (Array.isArray(v)) counts[k] = v.length;
const scalars = Object.keys(db).filter(k => !Array.isArray(db[k]));
const print = (title, o) => { console.log(title); for (const [k, v] of Object.entries(o)) console.log(`  ${k.padEnd(32)} ${v}`); };

if (problems.length) {
  console.error(`${problems.length} reference problem(s) would violate foreign keys:`);
  for (const p of problems.slice(0, 50)) console.error('  - ' + p);
}

let pool;
try {
  let plan;
  if (dryRun) {
    plan = diffDb({}, db);
    console.log('DRY RUN: nothing is written');
    if (process.env.DATABASE_URL) { // compare with what is already there, read-only
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const has = (await pool.query("SELECT to_regclass('meta') AS t")).rows[0].t;
      if (has) plan = diffDb(await loadAll(pool), db);
    }
  } else {
    if (problems.length) throw new Error('refusing to import with reference problems (see above)');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await migrate(pool, { log: m => console.log(m) });
    plan = await saveAll(pool, db);
  }
  print('rows per collection in db.json:', counts);
  console.log(`scalar keys -> meta: ${scalars.join(', ') || '(none)'}`);
  const w = {}; for (const u of plan.upserts) w[u.collection] = (w[u.collection] || 0) + 1;
  const d = {}; for (const u of plan.deletes) d[u.collection] = (d[u.collection] || 0) + 1;
  print(dryRun ? 'would upsert:' : 'upserted (new/changed):', w);
  print(dryRun ? 'would delete (stale in PG):' : 'deleted (stale in PG):', d);
  let stW = 0, stSame = 0;
  for (const s of states) {
    if (dryRun) {
      const cur = pool && (await pool.query("SELECT to_regclass('user_state') AS t")).rows[0].t ? await getUserState(pool, s.uid) : null;
      if (cur && canonicalize(cur.doc) === canonicalize(s.doc)) stSame++; else stW++;
    } else if (await importUserState(pool, s.uid, s.doc) === 'written') stW++; else stSame++;
  }
  console.log(`user_state docs: ${states.length} found, ${stW} ${dryRun ? 'to write' : 'written'}, ${stSame} unchanged`);
  if (!dryRun) {
    const back = await loadAll(pool);
    const ok = canonicalize(back) === canonicalize(db);
    console.log(`verification: PG db ${ok ? 'EQUALS' : 'DIFFERS FROM'} db.json (canonical)`);
    if (!ok) process.exitCode = 1;
  }
  if (problems.length) process.exitCode = 1;
} finally { if (pool) await pool.end(); }
