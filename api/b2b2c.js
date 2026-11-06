import crypto from 'node:crypto';

export const B2B2C_SCHEMA_VERSION = 2;
export const COACH_SCOPES = ['training', 'nutrition'];

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
  if (!Number.isInteger(db.schemaVersion) || db.schemaVersion < B2B2C_SCHEMA_VERSION) {
    db.schemaVersion = B2B2C_SCHEMA_VERSION;
    changed = true;
  }
  if (!Array.isArray(db.coachInvites)) { db.coachInvites = []; changed = true; }
  if (!Array.isArray(db.coachAthleteLinks)) { db.coachAthleteLinks = []; changed = true; }
  return changed;
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
