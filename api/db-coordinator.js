import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { syncDir } from './durable.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const syncSleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const clone = value => structuredClone(value);

export class FileLockTimeoutError extends Error {
  constructor() {
    super('timed out waiting for the database lock');
    this.name = 'FileLockTimeoutError';
  }
}

export class ConcurrentDbWriteError extends Error {
  constructor(key) {
    super(`concurrent database write conflict on ${key}`);
    this.name = 'ConcurrentDbWriteError';
    this.key = key;
  }
}

function sameValue(left, right, leftPresent = true, rightPresent = true) {
  return leftPresent === rightPresent && (!leftPresent || isDeepStrictEqual(left, right));
}

export function mergeDbCandidate(latest, base, candidate, { keys } = {}) {
  const merged = clone(latest);
  const names = keys ? new Set(keys) : new Set([...Object.keys(base), ...Object.keys(candidate), ...Object.keys(latest)]);
  for (const key of names) {
    const basePresent = Object.hasOwn(base, key);
    const candidatePresent = Object.hasOwn(candidate, key);
    const latestPresent = Object.hasOwn(latest, key);
    if (sameValue(base[key], candidate[key], basePresent, candidatePresent)) continue;
    if (!sameValue(base[key], latest[key], basePresent, latestPresent)
        && !sameValue(candidate[key], latest[key], candidatePresent, latestPresent)) {
      throw new ConcurrentDbWriteError(key);
    }
    if (candidatePresent) merged[key] = clone(candidate[key]);
    else delete merged[key];
  }
  return merged;
}

function ownerFile(lockPath) { return path.join(lockPath, 'owner.json'); }

function readOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(ownerFile(lockPath), 'utf8'));
    if (!value || typeof value.token !== 'string' || !Number.isFinite(value.expiresAt)) return null;
    return value;
  } catch { return null; }
}

function directoryIdentity(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch { return null; }
}

function sameIdentity(left, right) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

function writeOwner(lockPath, owner) {
  const file = ownerFile(lockPath);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDir(lockPath);
  syncDir(path.dirname(lockPath));
}

function refreshOwner(lockPath, token, leaseMs, now) {
  const current = readOwner(lockPath);
  if (!current || current.token !== token) return false;
  const refreshed = { ...current, expiresAt: now() + leaseMs };
  const file = ownerFile(lockPath);
  const tmp = `${file}.${token}.refresh`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(refreshed));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (readOwner(lockPath)?.token !== token) { fs.rmSync(tmp, { force: true }); return false; }
  fs.renameSync(tmp, file);
  syncDir(lockPath);
  return true;
}

function quarantineName(lockPath, label, token) {
  const safe = String(token || 'incomplete').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'incomplete';
  return `${lockPath}.${label}-${safe}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function isPidDead(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function expiredSnapshot(lockPath, leaseMs, now) {
  const identity = directoryIdentity(lockPath);
  if (!identity) return null;
  const owner = readOwner(lockPath);
  const ownerDead = owner && isPidDead(owner.pid);
  const expiresAt = owner?.expiresAt ?? identity.mtimeMs + leaseMs;
  if (!ownerDead && expiresAt > now()) return null;
  const verifiedOwner = readOwner(lockPath);
  const verifiedIdentity = directoryIdentity(lockPath);
  if (!sameIdentity(identity, verifiedIdentity)) return null;
  if ((owner?.token || null) !== (verifiedOwner?.token || null)) return null;
  const verifiedDead = verifiedOwner && isPidDead(verifiedOwner.pid);
  if (!verifiedDead && (verifiedOwner?.expiresAt ?? verifiedIdentity.mtimeMs + leaseMs) > now()) return null;
  return { token: verifiedOwner?.token || null, identity: verifiedIdentity };
}

function recoverExpired(lockPath, leaseMs, now) {
  const snapshot = expiredSnapshot(lockPath, leaseMs, now);
  if (!snapshot) return false;
  const quarantine = quarantineName(lockPath, 'expired', snapshot.token);
  try { fs.renameSync(lockPath, quarantine); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
    throw error;
  }
  const movedOwner = readOwner(quarantine);
  const movedIdentity = directoryIdentity(quarantine);
  const verified = sameIdentity(snapshot.identity, movedIdentity)
    && (snapshot.token === (movedOwner?.token || null));
  if (!verified) {
    try { if (!fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath); } catch { /* leave evidence, never delete an unverified owner */ }
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  syncDir(path.dirname(lockPath));
  return true;
}

function releaseOwned(lockPath, token) {
  const owner = readOwner(lockPath);
  if (!owner || owner.token !== token) return false;
  const quarantine = quarantineName(lockPath, 'release', token);
  try { fs.renameSync(lockPath, quarantine); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const moved = readOwner(quarantine);
  if (!moved || moved.token !== token) {
    try { if (!fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath); } catch { /* preserve the foreign lock */ }
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  syncDir(path.dirname(lockPath));
  return true;
}

export function createInterprocessLock({
  lockPath,
  leaseMs = 30_000,
  acquireTimeoutMs = 5_000,
  retryMs = 10,
  now = Date.now,
  token = () => `db_${crypto.randomBytes(18).toString('base64url')}`,
} = {}) {
  if (!lockPath) throw new TypeError('lockPath is required');
  for (const [name, value] of Object.entries({ leaseMs, acquireTimeoutMs, retryMs })) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }

  const attempt = () => {
    const ownerToken = token();
    let created = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      const acquiredAt = now();
      writeOwner(lockPath, { token: ownerToken, pid: process.pid, acquiredAt, expiresAt: acquiredAt + leaseMs });
      const heartbeat = setInterval(() => {
        try { if (!refreshOwner(lockPath, ownerToken, leaseMs, now)) clearInterval(heartbeat); } catch { clearInterval(heartbeat); }
      }, Math.max(50, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      return {
        token: ownerToken,
        release: async () => { clearInterval(heartbeat); return releaseOwned(lockPath, ownerToken); },
        releaseSync: () => { clearInterval(heartbeat); return releaseOwned(lockPath, ownerToken); },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        try {
          if (!releaseOwned(lockPath, ownerToken) && created && !readOwner(lockPath)) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            syncDir(path.dirname(lockPath));
          }
        } catch { /* original error wins */ }
        throw error;
      }
      if (recoverExpired(lockPath, leaseMs, now)) return attempt();
      return null;
    }
  };

  const acquire = async () => {
    const deadline = Date.now() + acquireTimeoutMs;
    while (true) {
      const handle = attempt();
      if (handle) return handle;
      if (Date.now() >= deadline) throw new FileLockTimeoutError();
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  };

  const acquireSync = () => {
    const deadline = Date.now() + acquireTimeoutMs;
    while (true) {
      const handle = attempt();
      if (handle) return handle;
      if (Date.now() >= deadline) throw new FileLockTimeoutError();
      Atomics.wait(syncSleepBuffer, 0, 0, Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  };

  return {
    acquire,
    acquireSync,
    async withLock(task) {
      const handle = await acquire();
      try { return await task(handle); }
      finally { await handle.release(); }
    },
    withLockSync(task) {
      const handle = acquireSync();
      try { return task(handle); }
      finally { handle.releaseSync(); }
    },
    async inspect() {
      const identity = directoryIdentity(lockPath);
      if (!identity) return { active: false, expired: false };
      const owner = readOwner(lockPath);
      const ownerDead = owner && isPidDead(owner.pid);
      const expiresAt = owner?.expiresAt ?? identity.mtimeMs + leaseMs;
      const active = !ownerDead && expiresAt > now();
      return { active, expired: !active };
    },
  };
}
