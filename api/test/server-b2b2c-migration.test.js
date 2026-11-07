import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';

function fixture(t, db, backup = 'backup-sentinel') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-b2b2c-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const raw = JSON.stringify(db, null, 2);
  fs.writeFileSync(path.join(dataDir, 'db.json'), raw);
  fs.writeFileSync(path.join(dataDir, 'db.json.bak'), backup);
  return { dataDir, raw, backup };
}

function start(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const exit = new Promise(resolve => child.once('exit', resolve));
  return { child, exit, log: () => log };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

for (const [name, db] of [
  ['future schema', { schemaVersion: 999, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [] }],
  ['corrupt B2B2C collection', { schemaVersion: 3, users: [], creds: [], subs: [], invites: [], coachInvites: {}, coachAthleteLinks: [], coachPrescriptions: [] }],
  ['corrupt prescription collection', { schemaVersion: 3, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: {} }],
  ['corrupt assessment collection', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: {} }],
  ['corrupt assessment record', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [{ id: 'bad' }] }],
  ['corrupt assessment payload', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [{ id: 'cas_bad', coachId: 'u_c', athleteId: 'u_a', assessedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', parq: { version: '2024.1', answers: [] } }] }],
  ['corrupt baseline collection', { schemaVersion: 3, users: null, creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [] }],
  ['corrupt message collection', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: {}, coachHabits: [], habitCheckins: [] }],
  ['corrupt message record', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [{ id: 'cmsg_bad' }], coachHabits: [], habitCheckins: [] }],
  ['corrupt habit record', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [{ id: 'hab_bad' }], habitCheckins: [] }],
  ['orphan habit check-in', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [{ id: 'hchk_bad', habitId: 'hab_missing' }] }],
  ['duplicate meal plan ids', {
    schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [1, 2].map(() => ({ id: 'mp_duplicate', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 2000,
      targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 }, meals: [{ id: 'm_1', name: 'Day', time: '08:00', items: [{ id: 'it_1', name: 'Menu', portion: 'day', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] }] }], notes: '', createdAt: 1, updatedAt: 1 })),
    mealAdherence: [],
  }],
  ['duplicate adherence ids', {
    schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [{ id: 'mp_1', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 2000,
      targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 }, meals: [{ id: 'm_1', name: 'Day', time: '08:00', items: [{ id: 'it_1', name: 'Menu', portion: 'day', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] }] }], notes: '', createdAt: 1, updatedAt: 1 }],
    mealAdherence: ['2026-11-05', '2026-11-06'].map(date => ({ id: 'adh_duplicate', athleteId: 'u_a', mealPlanId: 'mp_1', date, mealsChecked: [], waterDrunkMl: 0, notes: '', updatedAt: 1 })),
  }],
  ['duplicate meal ids', (() => {
    const item = { id: 'it_1', name: 'Menu', portion: 'day', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] };
    const meal = { id: 'm_duplicate', name: 'Day', time: '08:00', items: [item] };
    return { schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealAdherence: [],
      mealPlans: [{ id: 'mp_1', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 4000, targetMacros: { protein: 300, carbs: 500, fats: 130, fiber: 60, waterMl: 2500 }, meals: [meal, structuredClone(meal)], notes: '', createdAt: 1, updatedAt: 1 }] };
  })()],
  ['duplicate meal item ids', (() => {
    const item = { id: 'it_duplicate', name: 'Menu', portion: 'half day', calories: 1000, protein: 75, carbs: 125, fats: 32.5, fiber: 15, substitutes: [] };
    return { schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealAdherence: [],
      mealPlans: [{ id: 'mp_1', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 2000, targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 }, meals: [{ id: 'm_1', name: 'Day', time: '08:00', items: [item, structuredClone(item)] }], notes: '', createdAt: 1, updatedAt: 1 }] };
  })()],
]) {
  test(`${name} refuses boot without overwriting db.json or db.json.bak`, async t => {
    const sample = fixture(t, db);
    const server = start(sample.dataDir);
    assert.equal(await server.exit, 1);
    assert.match(server.log(), /B2B2C.*Refusing to start/i);
    assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'), sample.raw);
    assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json.bak'), 'utf8'), sample.backup);
  });
}

test('a valid legacy baseline with missing B2B2C fields migrates once', async t => {
  const sample = fixture(t, { users: [], creds: [], subs: [], invites: [] });
  const server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 6);
  assert.deepEqual(stored.coachInvites, []);
  assert.deepEqual(stored.coachAthleteLinks, []);
  assert.deepEqual(stored.coachPrescriptions, []);
  assert.deepEqual(stored.coachAssessments, []);
  assert.deepEqual(stored.mealPlans, []);
  assert.deepEqual(stored.mealAdherence, []);
  assert.deepEqual(stored.coachMessages, []);
  assert.deepEqual(stored.coachHabits, []);
  assert.deepEqual(stored.habitCheckins, []);
});

test('known schema versions migrate to version 6', async t => {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const sample = fixture(t, { schemaVersion, users: [], creds: [], subs: [], invites: [] });
    const server = start(sample.dataDir);
    await boundPort(server.child, server.log);
    await stop(server.child);
    const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
    assert.equal(stored.schemaVersion, 6);
    assert.deepEqual(stored.coachInvites, []);
    assert.deepEqual(stored.coachAthleteLinks, []);
    assert.deepEqual(stored.coachPrescriptions, []);
    assert.deepEqual(stored.coachAssessments, []);
    assert.deepEqual(stored.mealPlans, []);
    assert.deepEqual(stored.mealAdherence, []);
    assert.deepEqual(stored.coachMessages, []);
    assert.deepEqual(stored.coachHabits, []);
    assert.deepEqual(stored.habitCheckins, []);
  }
});

test('version 3 assessment PAR-Q answers migrate to stable question ids without granting new consent', async t => {
  const sample = fixture(t, {
    schemaVersion: 3,
    users: [], creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [],
    coachAthleteLinks: [{ id: 'cal_1', coachId: 'u_coach', athleteId: 'u_athlete', scopes: ['training'], status: 'active' }],
    coachAssessments: [{
      id: 'cas_1', coachId: 'u_coach', athleteId: 'u_athlete', assessedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      parq: { answers: [false, false, false, false, false, false, true], notes: 'legacy' },
    }],
  });
  const server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(stored.coachAthleteLinks[0].scopes, ['training']);
  assert.equal(stored.coachAssessments[0].parq.version, '2024.1');
  assert.equal(stored.coachAssessments[0].parq.answers[6].questionId, 'other_reason');
  assert.equal(stored.coachAssessments[0].requiresMedicalClearance, true);
});
