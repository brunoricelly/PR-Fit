import crypto from 'node:crypto';

export const B2B2C_SCHEMA_VERSION = 2;
export const COACH_SCOPES = ['training', 'nutrition'];

export class B2B2CDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'B2B2CDataError';
  }
}

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const uniqueAllowed = (value, allowed) => {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (!allowed.includes(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
};

export function migrateB2B2C(db) {
  let changed = false;
  if (db.schemaVersion === undefined) {
    db.schemaVersion = B2B2C_SCHEMA_VERSION;
    changed = true;
  } else {
    if (!Number.isInteger(db.schemaVersion)) throw new B2B2CDataError('schemaVersion must be an integer');
    if (db.schemaVersion > B2B2C_SCHEMA_VERSION) {
      throw new B2B2CDataError(`schemaVersion ${db.schemaVersion} is newer than supported version ${B2B2C_SCHEMA_VERSION}`);
    }
    if (![1, B2B2C_SCHEMA_VERSION].includes(db.schemaVersion)) {
      throw new B2B2CDataError(`schemaVersion ${db.schemaVersion} is not a known migration source`);
    }
    if (db.schemaVersion < B2B2C_SCHEMA_VERSION) {
      db.schemaVersion = B2B2C_SCHEMA_VERSION;
      changed = true;
    }
  }
  for (const key of ['coachInvites', 'coachAthleteLinks']) {
    if (db[key] === undefined) { db[key] = []; changed = true; continue; }
    if (!Array.isArray(db[key])) throw new B2B2CDataError(`${key} must be an array`);
  }
  return changed;
}

const rowTime = row => {
  for (const value of [row.updatedAt, row.endedAt, row.acceptedAt, row.expiredAt, row.closedAt, row.createdAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};
const newestFirst = (left, right) => rowTime(right) - rowTime(left) || String(left.id).localeCompare(String(right.id));
const oldestFirst = (left, right) => rowTime(left) - rowTime(right) || String(left.id).localeCompare(String(right.id));

function closePending(link, invite, nowIso, reason) {
  if (link.status !== 'pending') return false;
  link.status = 'ended';
  link.updatedAt = nowIso;
  link.endedAt = nowIso;
  link.endedReason = reason;
  if (invite) {
    if (reason === 'invite_expired') invite.expiredAt ||= nowIso;
    else {
      invite.closedAt ||= nowIso;
      invite.closedReason ||= reason;
    }
  }
  return true;
}

export function compactB2B2C(db, limits, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = nowMs - limits.terminalRetentionDays * 86400000;
  let changed = false;
  let linksById = new Map(db.coachAthleteLinks.map(link => [link.id, link]));

  for (const invite of db.coachInvites) {
    const link = linksById.get(invite.linkId);
    if (!link || invite.acceptedAt) continue;
    const expiry = Date.parse(invite.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= nowMs || link.status !== 'pending') {
      changed = closePending(link, invite, nowIso, 'invite_expired') || changed;
      if (!invite.expiredAt) { invite.expiredAt = nowIso; changed = true; }
    }
  }

  const inviteForLink = new Map(db.coachInvites.map(invite => [invite.linkId, invite]));
  const pendingLinks = () => db.coachAthleteLinks.filter(link => link.status === 'pending').sort(oldestFirst);
  const pendingInvites = () => db.coachInvites.filter(invite => linksById.get(invite.linkId)?.status === 'pending');

  while (pendingInvites().length > limits.maxInvites) {
    const link = pendingLinks()[0];
    if (!link) break;
    changed = closePending(link, inviteForLink.get(link.id), nowIso, 'storage_capacity') || changed;
  }
  while (db.coachAthleteLinks.filter(link => link.status !== 'ended').length > limits.maxLinks) {
    const link = pendingLinks()[0];
    if (!link) break;
    changed = closePending(link, inviteForLink.get(link.id), nowIso, 'storage_capacity') || changed;
  }

  const liveLinks = db.coachAthleteLinks.filter(link => link.status !== 'ended');
  if (liveLinks.length > limits.maxLinks) {
    throw new B2B2CDataError(`live coachAthleteLinks exceed configured limit ${limits.maxLinks}`);
  }

  const terminalSlots = Math.max(0, limits.maxLinks - liveLinks.length);
  const terminalLinks = db.coachAthleteLinks
    .filter(link => link.status === 'ended' && limits.terminalRetentionDays > 0 && rowTime(link) >= cutoff)
    .sort(newestFirst)
    .slice(0, Math.min(limits.terminalLinksKeep, terminalSlots));
  const keptLinks = [...liveLinks, ...terminalLinks];
  const keptLinkIds = new Set(keptLinks.map(link => link.id));
  if (keptLinks.length !== db.coachAthleteLinks.length) changed = true;
  db.coachAthleteLinks = keptLinks;
  linksById = new Map(keptLinks.map(link => [link.id, link]));

  const pending = db.coachInvites
    .filter(invite => linksById.get(invite.linkId)?.status === 'pending')
    .sort(newestFirst);
  if (pending.length > limits.maxInvites) throw new B2B2CDataError(`pending coachInvites exceed configured limit ${limits.maxInvites}`);
  const remaining = Math.max(0, limits.maxInvites - pending.length);
  const acceptedLive = db.coachInvites
    .filter(invite => invite.acceptedAt && keptLinkIds.has(invite.linkId) && linksById.get(invite.linkId)?.status !== 'ended')
    .sort(newestFirst)
    .slice(0, remaining);
  const terminalRemaining = Math.max(0, remaining - acceptedLive.length);
  const terminalInvites = db.coachInvites
    .filter(invite => linksById.get(invite.linkId)?.status === 'ended'
      && limits.terminalRetentionDays > 0 && rowTime(invite) >= cutoff)
    .sort(newestFirst)
    .slice(0, Math.min(limits.terminalInvitesKeep, terminalRemaining));
  const keptInvites = [...pending, ...acceptedLive, ...terminalInvites];
  if (keptInvites.length !== db.coachInvites.length) changed = true;
  db.coachInvites = keptInvites;
  return { changed, invites: keptInvites.length, links: keptLinks.length };
}

export function profileOf(user) {
  const profile = record(user?.profile) ? user.profile : null;
  if (profile?.kind !== 'coach') return { kind: 'athlete', coachSpecialties: [] };
  const specialties = uniqueAllowed(profile.coachSpecialties, COACH_SCOPES) || [];
  if (!specialties.length) return { kind: 'athlete', coachSpecialties: [] };
  return { kind: 'coach', coachSpecialties: specialties };
}

export function validateProfile(body) {
  if (!record(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.some(key => !['coachSpecialties', 'kind'].includes(key))) return null;
  if (body.kind === 'athlete') {
    const specialties = body.coachSpecialties === undefined ? [] : uniqueAllowed(body.coachSpecialties, COACH_SCOPES);
    return specialties?.length === 0 ? { kind: 'athlete', coachSpecialties: [] } : null;
  }
  if (body.kind !== 'coach') return null;
  const specialties = uniqueAllowed(body.coachSpecialties, COACH_SCOPES);
  return specialties?.length ? { kind: 'coach', coachSpecialties: specialties } : null;
}

export function validateScopes(scopes, specialties) {
  const normalized = uniqueAllowed(scopes, COACH_SCOPES);
  if (!normalized?.length) return null;
  return normalized.every(scope => specialties.includes(scope)) ? normalized : null;
}

export function capabilitiesFor(user) {
  const profile = profileOf(user);
  if (profile.kind !== 'coach') return [];
  const capabilities = ['relationships:invite', 'relationships:list', 'relationships:suspend', 'relationships:end'];
  for (const scope of profile.coachSpecialties) {
    capabilities.push(`athlete:${scope}:read`, `athlete:${scope}:write`);
  }
  return capabilities;
}

export function safeProfileUser(user, { includeProfile = true } = {}) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    ...(includeProfile ? { profile: profileOf(user) } : {}),
  };
}

export function makeOpaqueInvite() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

export function makeEntityId(prefix, rows) {
  let id;
  do { id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; }
  while (rows.some(row => row.id === id));
  return id;
}

export function linkForActor(db, actor, linkId) {
  const link = db.coachAthleteLinks.find(item => item.id === linkId);
  if (!link) return null;
  return link.coachId === actor?.id || link.athleteId === actor?.id ? link : null;
}

export function authorizeAthleteAccess(db, actor, athleteId, capability) {
  if (!actor) return { ok: false, code: 'not_signed_in' };
  if (actor.id === athleteId) return { ok: true, own: true, link: null };
  if (profileOf(actor).kind !== 'coach') return { ok: false, code: 'relationship_not_found' };
  const match = /^athlete:(training|nutrition):(read|write)$/.exec(capability);
  if (!match || !capabilitiesFor(actor).includes(capability)) return { ok: false, code: 'scope_forbidden' };
  const links = db.coachAthleteLinks.filter(item => item.coachId === actor.id && item.athleteId === athleteId);
  const link = links.find(item => item.status === 'active') || links.find(item => item.status !== 'ended') || links.at(-1);
  if (!link) return { ok: false, code: 'relationship_not_found' };
  if (link.status !== 'active') return { ok: false, code: 'relationship_inactive', link };
  if (!link.scopes.includes(match[1])) return { ok: false, code: 'scope_forbidden', link };
  return { ok: true, own: false, link };
}

export function serializeLink(db, link, viewer) {
  const coach = db.users.find(user => user.id === link.coachId);
  const athlete = db.users.find(user => user.id === link.athleteId);
  const out = {
    id: link.id,
    scopes: [...link.scopes],
    status: link.status,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    ...(link.acceptedAt ? { acceptedAt: link.acceptedAt } : {}),
    ...(link.suspendedAt ? { suspendedAt: link.suspendedAt } : {}),
    ...(link.endedAt ? { endedAt: link.endedAt } : {}),
  };
  if (viewer?.id === link.coachId) out.athlete = safeProfileUser(athlete, { includeProfile: false });
  if (viewer?.id === link.athleteId) out.coach = safeProfileUser(coach);
  return out;
}

export function removeB2B2CUser(db, userId) {
  db.coachInvites = db.coachInvites.filter(invite => invite.coachId !== userId && invite.acceptedBy !== userId);
  db.coachAthleteLinks = db.coachAthleteLinks.filter(link => link.coachId !== userId && link.athleteId !== userId);
}
