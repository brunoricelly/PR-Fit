import fs from 'node:fs';
import path from 'node:path';
import { createInterprocessLock, mergeDbCandidate } from '../../db-coordinator.js';
import { atomicWrite } from '../../durable.js';
import { createReminderDispatcher } from '../../reminder-dispatcher.js';

const [mode, dbFile, barrierDir, sinkFile, nowText] = process.argv.slice(2);
const now = Number(nowText);
const lock = createInterprocessLock({
  lockPath: `${dbFile}.lock`, leaseMs: 2000, acquireTimeoutMs: 5000, retryMs: 5,
});
const readDb = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const writeDb = db => atomicWrite(dbFile, JSON.stringify(db, null, 2), 0o600);
const ready = path.join(barrierDir, `ready-${process.pid}`);
fs.writeFileSync(ready, '');
while (!fs.existsSync(path.join(barrierDir, 'go'))) await new Promise(resolve => setTimeout(resolve, 2));

if (mode === 'dispatch') {
  const dispatcher = createReminderDispatcher({
    transaction: transform => lock.withLock(async () => {
      const candidate = readDb();
      const result = transform(candidate);
      if (result?.changed) writeDb(candidate);
      return result;
    }),
    deliver: async ({ idempotencyKey }) => {
      fs.appendFileSync(sinkFile, `${idempotencyKey}\n`);
      await new Promise(resolve => setTimeout(resolve, 25));
      return { status: 'delivered' };
    },
    now: () => now,
    randomId: kind => `${kind || 'id'}_${process.pid}_${Date.now()}`,
    config: { leaseMs: 1000, baseRetryMs: 1000, maxRetryMs: 4000, maxAttempts: 3, batchSize: 10 },
  });
  await dispatcher.tick();
} else if (mode === 'merge') {
  const base = readDb();
  const candidate = structuredClone(base);
  candidate[`worker_${path.basename(sinkFile)}`] = process.pid;
  await lock.withLock(async () => {
    const latest = readDb();
    writeDb(mergeDbCandidate(latest, base, candidate));
  });
} else {
  throw new Error(`unknown mode ${mode}`);
}
