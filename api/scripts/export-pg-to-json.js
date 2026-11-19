#!/usr/bin/env node
// Exports PostgreSQL back to db.json + state-<uid>.json (rollback path / verification).
//   node scripts/export-pg-to-json.js --out DIR     (DATABASE_URL required)
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadAll, listUserStates } from '../store/pg-store.js';

const i = process.argv.indexOf('--out');
const out = i >= 0 ? process.argv[i + 1] : undefined;
if (!out || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=... export-pg-to-json.js --out DIR'); process.exit(2); }
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const db = await loadAll(pool);
  fs.writeFileSync(path.join(out, 'db.json'), JSON.stringify(db, null, 2), { mode: 0o600 });
  const states = await listUserStates(pool);
  for (const s of states) {
    if (!/^[a-zA-Z0-9_-]+$/.test(s.uid)) throw new Error(`unsafe uid ${s.uid}`);
    fs.writeFileSync(path.join(out, `state-${s.uid}.json`), JSON.stringify(s.doc), { mode: 0o600 });
  }
  console.log(`exported db.json (${Object.keys(db).length} keys) and ${states.length} state files to ${out}`);
} finally { await pool.end(); }
