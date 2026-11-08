import crypto from 'node:crypto';
import { createWindow } from './rate-limit.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const TYPES = new Set(['workouts_count', 'habits_consistency', 'volume_load', 'custom_points']);
const SCOPES = new Set(['group', 'coach_students']);
const STATUSES = new Set(['draft', 'active', 'completed', 'archived']);
const ROLES = new Set(['member', 'moderator']);
const MEMBER_STATUSES = new Set(['pending', 'active', 'removed', 'left']);
const GROUP_KEYS = new Set(['id', 'coachId', 'name', 'description', 'category', 'maxMembers', 'isPrivate', 'memberCount', 'createdAt', 'updatedAt', 'archivedAt']);
const MEMBER_KEYS = new Set(['id', 'groupId', 'coachId', 'athleteId', 'joinedAt', 'acceptedAt', 'role', 'status', 'updatedAt']);
const INVITE_KEYS = new Set(['id', 'groupId', 'coachId', 'code', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'revokedAt']);
const CHALLENGE_KEYS = new Set(['id', 'coachId', 'groupId', 'scope', 'title', 'description', 'type', 'startAt', 'endAt', 'timeZone', 'status', 'rules', 'participantIds', 'createdAt', 'updatedAt', 'activatedAt', 'completedAt', 'archivedAt']);
const SCORE_KEYS = new Set(['id', 'challengeId', 'athleteId', 'score', 'workoutsCount', 'volumeLoad', 'habitCheckinsCount', 'lastActivityAt', 'updatedAt', 'finalized']);
const FEED_KEYS = new Set(['id', 'challengeId', 'athleteId', 'activityType', 'sourceId', 'description', 'pointsAwarded', 'timestamp', 'reason', 'idempotencyKey', 'createdAt', 'finalized']);

export const CHALLENGE_LIMITS = Object.freeze({
  maxGroupsPerCoach: 50, maxGroups: 5000, maxMembersPerGroup: 500, maxGroupMemberships: 100000,
  maxGroupInvites: 20000, maxChallengesPerCoach: 100, maxChallenges: 5000,
  maxScoresPerChallenge: 2000, maxActivityFeedPerChallenge: 1000, maxActivityFeed: 50000,
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.has(key));
const date = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const nullableDate = value => value === null || date(value);
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const clean = (value, max, required = false) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return (required && !out) || out.length > max ? null : out;
};

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value) return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
}

function entityId(prefix, rows) {
  const used = new Set(rows.map(row => row?.id));
  let id;
  do { id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; } while (used.has(id));
  return id;
}

function newInviteCode(rows) {
  const used = new Set(rows.map(row => String(row?.code || '').toUpperCase()));
  let code;
  do { code = `GRP-${crypto.randomBytes(8).toString('hex').toUpperCase()}`; } while (used.has(code));
  return code;
}

function rulesFor(type, rules) {
  if (!record(rules)) return null;
  if (type === 'workouts_count') return exact(rules, new Set(['pointsPerWorkout'])) && number(rules.pointsPerWorkout, 0.01, 1000) ? { pointsPerWorkout: rules.pointsPerWorkout } : null;
  if (type === 'volume_load') return exact(rules, new Set(['pointsPer1000'])) && number(rules.pointsPer1000, 0.01, 1000) ? { pointsPer1000: rules.pointsPer1000 } : null;
  if (type === 'habits_consistency') {
    return exact(rules, new Set(['pointsPerCheckin', 'habitIds'])) && number(rules.pointsPerCheckin, 0.01, 1000)
      && Array.isArray(rules.habitIds) && rules.habitIds.length >= 1 && rules.habitIds.length <= 50
      && rules.habitIds.every(id => typeof id === 'string' && ID_RE.test(id)) && new Set(rules.habitIds).size === rules.habitIds.length
      ? { pointsPerCheckin: rules.pointsPerCheckin, habitIds: [...rules.habitIds] } : null;
  }
  if (type === 'custom_points') {
    return exact(rules, new Set(['maxPointsPerAdjustment', 'maxAbsoluteScore']))
      && Number.isInteger(rules.maxPointsPerAdjustment) && rules.maxPointsPerAdjustment >= 1 && rules.maxPointsPerAdjustment <= 10000
      && (rules.maxAbsoluteScore === undefined || Number.isInteger(rules.maxAbsoluteScore) && rules.maxAbsoluteScore >= rules.maxPointsPerAdjustment && rules.maxAbsoluteScore <= 1000000)
      ? { maxPointsPerAdjustment: rules.maxPointsPerAdjustment, ...(rules.maxAbsoluteScore === undefined ? {} : { maxAbsoluteScore: rules.maxAbsoluteScore }) } : null;
  }
  return null;
}

export function activeTrainingLink(db, coachId, athleteId) {
  return (db.coachAthleteLinks || []).find(link => link.coachId === coachId && link.athleteId === athleteId
    && link.status === 'active' && Array.isArray(link.scopes) && link.scopes.includes('training')) || null;
}

function currentEligibleIds(db, challenge) {
  if (challenge.scope === 'group') {
    return [...new Set(db.groupMembers.filter(member => member.groupId === challenge.groupId && member.status === 'active'
      && activeTrainingLink(db, challenge.coachId, member.athleteId)).map(member => member.athleteId))].sort();
  }
  return [...new Set(db.coachAthleteLinks.filter(link => link.coachId === challenge.coachId && link.status === 'active'
    && link.scopes.includes('training')).map(link => link.athleteId))].sort();
}

export const challengeAllowsAthlete = (db, challenge, athleteId) => challenge.participantIds.includes(athleteId);

function participantValid(db, challenge, athleteId, historical) {
  const user = db.users.find(row => row.id === athleteId);
  if (!user) return false;
  if (historical) return true;
  if (challenge.scope === 'group') {
    return db.groupMembers.some(row => row.groupId === challenge.groupId && row.athleteId === athleteId && row.status === 'active')
      && !!activeTrainingLink(db, challenge.coachId, athleteId);
  }
  return !!activeTrainingLink(db, challenge.coachId, athleteId);
}

export function validateChallengesState(db, limits = CHALLENGE_LIMITS) {
  for (const key of ['coachGroups', 'groupMembers', 'groupInvites', 'challenges', 'challengeScores', 'challengeActivityFeed']) {
    if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  }
  if (db.coachGroups.length > (limits.maxGroups ?? 5000) || db.groupMembers.length > (limits.maxGroupMemberships ?? 100000)
      || db.groupInvites.length > (limits.maxGroupInvites ?? 20000) || db.challenges.length > (limits.maxChallenges ?? 5000)) throw new Error('challenge collection quota exceeded');
  const users = new Map(db.users.map(user => [user.id, user]));
  const groups = new Map();
  const perCoachGroups = new Map();
  for (const group of db.coachGroups) {
    if (!exact(group, GROUP_KEYS) || !ID_RE.test(group.id) || groups.has(group.id) || users.get(group.coachId)?.profile?.kind !== 'coach'
        || !clean(group.name, 100, true) || clean(group.description, 1000) === null || !clean(group.category, 50, true)
        || !Number.isInteger(group.maxMembers) || group.maxMembers < 1 || group.maxMembers > (limits.maxMembersPerGroup ?? 500)
        || typeof group.isPrivate !== 'boolean' || !Number.isInteger(group.memberCount) || group.memberCount < 0
        || !date(group.createdAt) || !date(group.updatedAt) || !nullableDate(group.archivedAt)) throw new Error('coachGroups contains invalid data');
    groups.set(group.id, group); perCoachGroups.set(group.coachId, (perCoachGroups.get(group.coachId) || 0) + 1);
  }
  if ([...perCoachGroups.values()].some(count => count > (limits.maxGroupsPerCoach ?? 50))) throw new Error('coach group quota exceeded');
  const memberIds = new Set(), memberPairs = new Set(), activeCounts = new Map();
  for (const member of db.groupMembers) {
    const group = groups.get(member.groupId), athlete = users.get(member.athleteId), pair = `${member.groupId}\0${member.athleteId}`;
    if (!exact(member, MEMBER_KEYS) || !ID_RE.test(member.id) || memberIds.has(member.id) || !group || group.coachId !== member.coachId
        || !athlete || memberPairs.has(pair) || !ROLES.has(member.role) || !MEMBER_STATUSES.has(member.status)
        || !date(member.joinedAt) || !date(member.updatedAt) || !nullableDate(member.acceptedAt)) throw new Error('groupMembers contains invalid data');
    if (member.status === 'pending' && member.acceptedAt !== null || member.status === 'active' && !date(member.acceptedAt)) throw new Error('groupMembers contains invalid lifecycle data');
    memberIds.add(member.id); memberPairs.add(pair);
    if (member.status === 'active') {
      activeCounts.set(member.groupId, (activeCounts.get(member.groupId) || 0) + 1);
    }
  }
  for (const group of groups.values()) {
    const count = activeCounts.get(group.id) || 0;
    if (group.memberCount !== count) throw new Error(`memberCount mismatch for ${group.id}`);
    if (count > group.maxMembers) throw new Error(`group capacity exceeded for ${group.id}`);
  }
  const inviteIds = new Set(), inviteCodes = new Set(), activeInvites = new Set();
  for (const invite of db.groupInvites) {
    const group = groups.get(invite.groupId), code = typeof invite.code === 'string' ? invite.code.toUpperCase() : '';
    if (!exact(invite, INVITE_KEYS) || !ID_RE.test(invite.id) || inviteIds.has(invite.id) || !group || group.coachId !== invite.coachId
        || !/^GRP-[A-F0-9]{16}$/.test(code) || inviteCodes.has(code) || !['active', 'revoked'].includes(invite.status)
        || !date(invite.createdAt) || !date(invite.updatedAt) || !date(invite.expiresAt) || !nullableDate(invite.revokedAt)
        || invite.status === 'active' && invite.revokedAt !== null || invite.status === 'revoked' && !date(invite.revokedAt)) throw new Error('groupInvites contains invalid data');
    if (invite.status === 'active' && activeInvites.has(invite.groupId)) throw new Error('multiple active invites for group');
    inviteIds.add(invite.id); inviteCodes.add(code); if (invite.status === 'active') activeInvites.add(invite.groupId);
  }
  const challenges = new Map(), perCoachChallenges = new Map();
  for (const challenge of db.challenges) {
    const group = challenge.scope === 'group' ? groups.get(challenge.groupId) : null;
    if (!exact(challenge, CHALLENGE_KEYS) || !ID_RE.test(challenge.id) || challenges.has(challenge.id)
        || users.get(challenge.coachId)?.profile?.kind !== 'coach' || !TYPES.has(challenge.type) || !SCOPES.has(challenge.scope)
        || challenge.scope === 'group' && (!group || group.coachId !== challenge.coachId) || challenge.scope === 'coach_students' && challenge.groupId !== null
        || !clean(challenge.title, 100, true) || clean(challenge.description, 2000) === null || !date(challenge.startAt) || !date(challenge.endAt)
        || Date.parse(challenge.endAt) <= Date.parse(challenge.startAt) || !validTimeZone(challenge.timeZone) || !STATUSES.has(challenge.status)
        || !rulesFor(challenge.type, challenge.rules) || !Array.isArray(challenge.participantIds) || new Set(challenge.participantIds).size !== challenge.participantIds.length
        || challenge.participantIds.some(id => typeof id !== 'string' || !ID_RE.test(id)) || !date(challenge.createdAt) || !date(challenge.updatedAt)
        || !nullableDate(challenge.activatedAt) || !nullableDate(challenge.completedAt) || !nullableDate(challenge.archivedAt)) throw new Error('challenges contains invalid data');
    if (challenge.status === 'draft' && (challenge.participantIds.length || challenge.activatedAt || challenge.completedAt || challenge.archivedAt)) throw new Error('invalid draft lifecycle');
    if (challenge.status === 'active' && (!challenge.activatedAt || challenge.completedAt || challenge.archivedAt)) throw new Error('invalid active lifecycle');
    if (challenge.status === 'completed' && (!challenge.activatedAt || !challenge.completedAt || challenge.archivedAt)) throw new Error('invalid completed lifecycle');
    if (challenge.status === 'archived' && !challenge.archivedAt) throw new Error('invalid archived lifecycle');
    const historical = ['completed', 'archived'].includes(challenge.status);
    if (challenge.participantIds.some(id => !participantValid(db, challenge, id, historical))) throw new Error('challenge participant is ineligible');
    challenges.set(challenge.id, challenge); perCoachChallenges.set(challenge.coachId, (perCoachChallenges.get(challenge.coachId) || 0) + 1);
  }
  if ([...perCoachChallenges.values()].some(count => count > (limits.maxChallengesPerCoach ?? 100))) throw new Error('coach challenge quota exceeded');
  const scoreIds = new Set(), scorePairs = new Set(), scoreCounts = new Map();
  for (const score of db.challengeScores) {
    const challenge = challenges.get(score.challengeId), pair = `${score.challengeId}\0${score.athleteId}`;
    if (!exact(score, SCORE_KEYS) || !ID_RE.test(score.id) || scoreIds.has(score.id) || scorePairs.has(pair) || !challenge || !challengeAllowsAthlete(db, challenge, score.athleteId)
        || !number(score.score, -1000000, 1000000) || !Number.isInteger(score.workoutsCount) || score.workoutsCount < 0 || !number(score.volumeLoad, 0, 1e12)
        || !Number.isInteger(score.habitCheckinsCount) || score.habitCheckinsCount < 0 || !nullableDate(score.lastActivityAt) || !date(score.updatedAt) || typeof score.finalized !== 'boolean'
        || ['completed', 'archived'].includes(challenge.status) !== score.finalized) throw new Error('challengeScores contains invalid or duplicate data');
    scoreIds.add(score.id); scorePairs.add(pair); scoreCounts.set(score.challengeId, (scoreCounts.get(score.challengeId) || 0) + 1);
  }
  if ([...scoreCounts.values()].some(count => count > (limits.maxScoresPerChallenge ?? 2000))) throw new Error('score quota exceeded');
  const feedIds = new Set(), feedSources = new Set(), idempotencyKeys = new Set(), correctedTargets = new Set(), feedCounts = new Map();
  for (const feed of db.challengeActivityFeed) {
    const challenge = challenges.get(feed.challengeId), source = `${feed.challengeId}\0${feed.activityType}\0${feed.sourceId}`;
    const idempotency = feed.idempotencyKey === null ? null : `${feed.challengeId}\0${feed.idempotencyKey}`;
    if (!exact(feed, FEED_KEYS) || !ID_RE.test(feed.id) || feedIds.has(feed.id) || feedSources.has(source) || !challenge || !challengeAllowsAthlete(db, challenge, feed.athleteId)
        || !['workout_completed', 'habit_checkin', 'custom_adjustment'].includes(feed.activityType) || typeof feed.sourceId !== 'string' || !ID_RE.test(feed.sourceId)
        || !clean(feed.description, 160, true) || !number(feed.pointsAwarded, -10000, 1e9) || !date(feed.timestamp) || !date(feed.createdAt)
        || !(feed.reason === null || typeof feed.reason === 'string' && clean(feed.reason, 500, true))
        || !(feed.idempotencyKey === null || typeof feed.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{8,120}$/.test(feed.idempotencyKey)) || idempotency !== null && idempotencyKeys.has(idempotency)
        || typeof feed.finalized !== 'boolean' || ['completed', 'archived'].includes(challenge.status) !== feed.finalized) throw new Error('challengeActivityFeed contains invalid or duplicate data');
    if (feed.activityType === 'custom_adjustment' && (challenge.type !== 'custom_points' || !feed.reason || !feed.idempotencyKey)) throw new Error('invalid custom points event');
    if (feed.activityType !== 'custom_adjustment' && (feed.reason !== null || feed.idempotencyKey !== null)) throw new Error('real event has custom fields');
    if (feed.activityType === 'workout_completed' && !['workouts_count', 'volume_load'].includes(challenge.type)
        || feed.activityType === 'habit_checkin' && challenge.type !== 'habits_consistency') throw new Error('challenge activity type does not match challenge');
    if (feed.activityType === 'custom_adjustment') {
      const target = db.challengeActivityFeed.find(row => row.id === feed.sourceId && row.challengeId === feed.challengeId);
      if (target) {
        if (target.activityType !== 'custom_adjustment' || target.athleteId !== feed.athleteId || feed.pointsAwarded !== -target.pointsAwarded || correctedTargets.has(target.id)) throw new Error('invalid custom points correction');
        correctedTargets.add(target.id);
      }
    }
    feedIds.add(feed.id); feedSources.add(source); if (idempotency !== null) idempotencyKeys.add(idempotency); feedCounts.set(feed.challengeId, (feedCounts.get(feed.challengeId) || 0) + 1);
  }
  if (db.challengeActivityFeed.length > (limits.maxActivityFeed ?? 50000) || [...feedCounts.values()].some(count => count > (limits.maxActivityFeedPerChallenge ?? 1000))) throw new Error('feed quota exceeded');
  return true;
}

export function compactChallengesState(db, limits = CHALLENGE_LIMITS) {
  const groups = new Map();
  for (const row of db.challengeActivityFeed) { const list = groups.get(row.challengeId) || []; list.push(row); groups.set(row.challengeId, list); }
  const kept = [];
  for (const list of groups.values()) kept.push(...list.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.id.localeCompare(b.id)).slice(0, limits.maxActivityFeedPerChallenge ?? 1000));
  kept.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.id.localeCompare(b.id));
  kept.splice(limits.maxActivityFeed ?? 50000);
  const changed = kept.length !== db.challengeActivityFeed.length;
  if (changed) db.challengeActivityFeed = kept;
  return { changed };
}

export function removeChallengesUser(db, userId) {
  db.coachGroups ||= []; db.groupMembers ||= []; db.groupInvites ||= []; db.challenges ||= []; db.challengeScores ||= []; db.challengeActivityFeed ||= [];
  const groupIds = new Set(db.coachGroups.filter(row => row.coachId === userId).map(row => row.id));
  const challengeIds = new Set(db.challenges.filter(row => row.coachId === userId || groupIds.has(row.groupId)).map(row => row.id));
  db.coachGroups = db.coachGroups.filter(row => !groupIds.has(row.id));
  db.groupMembers = db.groupMembers.filter(row => !groupIds.has(row.groupId) && row.athleteId !== userId);
  db.groupInvites = db.groupInvites.filter(row => !groupIds.has(row.groupId));
  db.challenges = db.challenges.filter(row => !challengeIds.has(row.id)).map(row => ({ ...row, participantIds: (row.participantIds || []).filter(id => id !== userId) }));
  db.challengeScores = db.challengeScores.filter(row => !challengeIds.has(row.challengeId) && row.athleteId !== userId);
  db.challengeActivityFeed = db.challengeActivityFeed.filter(row => !challengeIds.has(row.challengeId) && row.athleteId !== userId);
  for (const group of db.coachGroups) group.memberCount = db.groupMembers.filter(row => row.groupId === group.id && row.status === 'active').length;
}

function activityTime(row) {
  if (typeof row?.start === 'number' && Number.isFinite(row.start)) return row.start;
  for (const value of [row?.completedAt, row?.updatedAt, row?.timestamp, row?.d && `${row.d}T12:00:00.000Z`, row?.date && `${row.date}T12:00:00.000Z`]) {
    const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function derivedScore(challenge, athleteId, db, readState) {
  const start = Date.parse(challenge.startAt), end = Date.parse(challenge.endAt), state = readState(athleteId) || {};
  const workouts = (Array.isArray(state.workouts) ? state.workouts : []).filter(row => activityTime(row) >= start && activityTime(row) <= end);
  const habits = new Set(challenge.type === 'habits_consistency' ? challenge.rules.habitIds : []);
  const checkins = db.habitCheckins.filter(row => row.athleteId === athleteId && row.completed === true && habits.has(row.habitId) && activityTime(row) >= start && activityTime(row) <= end);
  const volumeLoad = workouts.reduce((sum, row) => sum + (number(row.vol, 0, 1e12) ? row.vol : 0), 0);
  let score = 0;
  if (challenge.type === 'workouts_count') score = workouts.length * challenge.rules.pointsPerWorkout;
  if (challenge.type === 'volume_load') score = volumeLoad / 1000 * challenge.rules.pointsPer1000;
  if (challenge.type === 'habits_consistency') score = checkins.length * challenge.rules.pointsPerCheckin;
  const events = [];
  for (const workout of ['workouts_count', 'volume_load'].includes(challenge.type) ? workouts : []) {
    const points = challenge.type === 'workouts_count' ? challenge.rules.pointsPerWorkout : (number(workout.vol, 0, 1e12) ? workout.vol : 0) / 1000 * challenge.rules.pointsPer1000;
    const stamp = new Date(activityTime(workout)).toISOString();
    events.push({ id: `evt_${crypto.createHash('sha256').update(`${challenge.id}\0w\0${athleteId}\0${workout.id}`).digest('hex').slice(0, 24)}`, challengeId: challenge.id, athleteId,
      activityType: 'workout_completed', sourceId: String(workout.id), description: 'Treino concluído', pointsAwarded: Math.round(points * 1000) / 1000,
      timestamp: stamp, reason: null, idempotencyKey: null, createdAt: stamp, finalized: false });
  }
  for (const checkin of challenge.type === 'habits_consistency' ? checkins : []) {
    const stamp = new Date(activityTime(checkin)).toISOString();
    events.push({ id: `evt_${crypto.createHash('sha256').update(`${challenge.id}\0h\0${athleteId}\0${checkin.id}`).digest('hex').slice(0, 24)}`, challengeId: challenge.id, athleteId,
      activityType: 'habit_checkin', sourceId: String(checkin.id), description: 'Hábito concluído', pointsAwarded: challenge.rules.pointsPerCheckin,
      timestamp: stamp, reason: null, idempotencyKey: null, createdAt: stamp, finalized: false });
  }
  const times = [...workouts, ...checkins].map(activityTime).filter(Number.isFinite);
  return { score: Math.round(score * 1000) / 1000, workoutsCount: workouts.length, volumeLoad: Math.round(volumeLoad * 1000) / 1000,
    habitCheckinsCount: checkins.length, lastActivityAt: times.length ? new Date(Math.max(...times)).toISOString() : null, events };
}

const effectiveStatus = (challenge, nowMs) => challenge.status === 'active' && nowMs >= Date.parse(challenge.endAt) ? 'completed' : challenge.status;
const publicChallenge = (challenge, nowMs) => ({ id: challenge.id, groupId: challenge.groupId, scope: challenge.scope, title: challenge.title,
  description: challenge.description, type: challenge.type, startAt: challenge.startAt, endAt: challenge.endAt, timeZone: challenge.timeZone,
  status: effectiveStatus(challenge, nowMs), rules: structuredClone(challenge.rules), createdAt: challenge.createdAt, updatedAt: challenge.updatedAt });
const nameOf = user => clean(user?.profile?.publicDisplayName, 60) || clean(user?.name, 80)?.split(/\s+/)[0] || 'Atleta';
const participantKey = (challengeId, athleteId) => crypto.createHash('sha256').update(`${challengeId}\0${athleteId}`).digest('base64url').slice(0, 16);

export function calculateChallengeLeaderboard(challenge, { db, readState = () => null, nowMs = Date.now() }) {
  const final = ['completed', 'archived'].includes(challenge.status);
  const scores = new Map(db.challengeScores.filter(row => row.challengeId === challenge.id && (!final || row.finalized)).map(row => [row.athleteId, row]));
  const feed = db.challengeActivityFeed.filter(row => row.challengeId === challenge.id && (!final || row.finalized));
  const leaderboard = [];
  for (const athleteId of challenge.participantIds) {
    let stats = scores.get(athleteId);
    if (!stats && challenge.type !== 'custom_points') { stats = derivedScore(challenge, athleteId, db, readState); feed.push(...stats.events); }
    stats ||= { score: 0, workoutsCount: 0, volumeLoad: 0, habitCheckinsCount: 0, lastActivityAt: null };
    leaderboard.push({ athleteId, participantKey: participantKey(challenge.id, athleteId), displayName: nameOf(db.users.find(row => row.id === athleteId)),
      score: stats.score, workoutsCount: stats.workoutsCount, volumeLoad: stats.volumeLoad, habitCheckinsCount: stats.habitCheckinsCount, lastActivityAt: stats.lastActivityAt });
  }
  leaderboard.sort((a, b) => b.score - a.score || (a.lastActivityAt === null) - (b.lastActivityAt === null)
    || String(a.lastActivityAt || '').localeCompare(String(b.lastActivityAt || '')) || a.participantKey.localeCompare(b.participantKey));
  return { challenge: publicChallenge(challenge, nowMs), leaderboard: leaderboard.map((row, index) => ({ ...row, rank: index + 1 })),
    activityFeed: feed.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.id.localeCompare(b.id)) };
}

const publicGroup = group => ({ id: group.id, name: group.name, description: group.description, category: group.category, maxMembers: group.maxMembers,
  isPrivate: group.isPrivate, memberCount: group.memberCount, createdAt: group.createdAt, updatedAt: group.updatedAt, archivedAt: group.archivedAt });
const publicMember = (member, db, coach = false) => ({ id: member.id, ...(coach ? { athleteId: member.athleteId } : {}), displayName: nameOf(db.users.find(row => row.id === member.athleteId)),
  role: member.role, status: member.status, joinedAt: member.joinedAt, acceptedAt: member.acceptedAt, updatedAt: member.updatedAt });

function cursorCodec(secret) {
  const signature = text => crypto.createHmac('sha256', secret).update(text).digest('base64url');
  return {
    encode(payload) { const text = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${text}.${signature(text)}`; },
    decode(value, tenant, kind) {
      if (!value) return 0;
      const [text, sig, extra] = String(value).split('.');
      if (!text || !sig || extra || signature(text) !== sig) return null;
      try { const payload = JSON.parse(Buffer.from(text, 'base64url')); return payload.tenant === tenant && payload.kind === kind && Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : null; } catch { return null; }
    },
  };
}

function paginate(req, rows, codec, tenant, kind, prefix = '') {
  const query = new URL(req.url, 'http://x').searchParams, raw = query.get(`${prefix}limit`), limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be between 1 and 100' };
  const offset = codec.decode(query.get(`${prefix}cursor`), tenant, kind); if (offset === null) return { error: 'invalid cursor' };
  const items = rows.slice(offset, offset + limit), next = offset + items.length;
  return { items, page: { limit, hasMore: next < rows.length, nextCursor: next < rows.length ? codec.encode({ tenant, kind, offset: next }) : null } };
}

const failure = (status, code, message, headers) => ({ status, code, message, headers });

export function createChallengeRoutes(context) {
  const { audit, b2bError, db, json, limitAddress, limits = CHALLENGE_LIMITS, profileOf, readBody, readSession, readState = () => null,
    transaction, cursorSecret = 'challenge-cursor', now = Date.now, rate = {}, inviteTtlMs = 30 * 86400000 } = context;
  const codec = cursorCodec(cursorSecret);
  const mutationAccount = createWindow({ max: rate.challengeMutationAccount ?? 120, windowMs: rate.windowMs ?? 3600000 });
  const mutationIp = createWindow({ max: rate.challengeMutationIp ?? 600, windowMs: rate.windowMs ?? 3600000 });
  const joinAccount = createWindow({ max: rate.groupJoinAccount ?? 60, windowMs: rate.windowMs ?? 3600000 });
  const joinIp = createWindow({ max: rate.groupJoinIp ?? 300, windowMs: rate.windowMs ?? 3600000 });
  const throttle = (req, res, actor, join = false) => {
    const waits = [(join ? joinAccount : mutationAccount).take(actor.id), (join ? joinIp : mutationIp).take(limitAddress(req))].filter(Boolean);
    if (!waits.length) return false;
    const wait = Math.max(...waits); b2bError(res, 429, 'rate_limited', 'too many group or challenge requests', { 'Retry-After': String(wait) }); return true;
  };
  const coachOnly = (req, res) => { const user = readSession(req); if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; } if (profileOf(user).kind !== 'coach') { b2bError(res, 403, 'role_forbidden', 'coach role required'); return null; } return user; };
  const athleteOnly = (req, res) => { const user = readSession(req); if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; } return user; };
  const run = async (req, res, operation, success = 200) => {
    try {
      const result = await transaction(operation);
      if (result.error) return b2bError(res, result.error.status, result.error.code, result.error.message, result.error.headers);
      if (result.audit) audit?.(req, result.audit.event, result.audit.data);
      json(res, success, result.value);
    } catch (error) { b2bError(res, 503, 'storage_unavailable', error.message); }
  };
  const ownedGroup = (state, id, coachId) => { const group = state.coachGroups.find(row => row.id === id); return !group ? { error: failure(404, 'group_not_found', 'group not found') } : group.coachId !== coachId ? { error: failure(403, 'access_denied', 'access denied') } : { group }; };

  const routes = {};

  routes['POST /api/coach/groups'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return;
    const body = await readBody(req);
    if (!exact(body, new Set(['name', 'description', 'category', 'maxMembers', 'isPrivate']))) return b2bError(res, 400, 'invalid_request', 'unknown group field');
    const name = clean(body.name, 100, true), description = clean(body.description, 1000), category = body.category === undefined ? 'geral' : clean(body.category, 50, true);
    const maxMembers = body.maxMembers === undefined ? 50 : body.maxMembers, isPrivate = body.isPrivate === undefined ? true : body.isPrivate;
    if (!name || description === null || !category || !Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > (limits.maxMembersPerGroup ?? 500) || typeof isPrivate !== 'boolean') return b2bError(res, 400, 'invalid_group', 'invalid group fields');
    await run(req, res, state => {
      if (state.coachGroups.length >= (limits.maxGroups ?? 5000) || state.coachGroups.filter(row => row.coachId === coach.id).length >= (limits.maxGroupsPerCoach ?? 50)) return { changed: false, error: failure(409, 'group_limit_reached', 'group quota reached') };
      const stamp = new Date(now()).toISOString();
      const group = { id: entityId('cgrp', state.coachGroups), coachId: coach.id, name, description, category, maxMembers, isPrivate, memberCount: 0, createdAt: stamp, updatedAt: stamp, archivedAt: null };
      state.coachGroups.push(group);
      state.groupInvites.push({ id: entityId('ginv', state.groupInvites), groupId: group.id, coachId: coach.id, code: newInviteCode(state.groupInvites), status: 'active', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now() + inviteTtlMs).toISOString(), revokedAt: null });
      return { changed: true, value: { group: publicGroup(group) }, audit: { event: 'coach.group.create', data: { user: coach, groupId: group.id } } };
    }, 201);
  };

  routes['GET /api/coach/groups'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach) return;
    const result = paginate(req, db.coachGroups.filter(row => row.coachId === coach.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(publicGroup), codec, coach.id, 'coach-groups');
    if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { groups: result.items, page: result.page });
  };

  routes['GET /api/coach/groups/{groupId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach) return; const owned = ownedGroup(db, req.groupId, coach.id); if (owned.error) return b2bError(res, owned.error.status, owned.error.code, owned.error.message);
    const result = paginate(req, db.groupMembers.filter(row => row.groupId === req.groupId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(row => publicMember(row, db, true)), codec, `${coach.id}:${req.groupId}`, 'group-members');
    if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { group: publicGroup(owned.group), members: result.items, page: result.page });
  };

  routes['PUT /api/coach/groups/{groupId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    if (!exact(body, new Set(['name', 'description', 'category', 'maxMembers', 'isPrivate', 'archived', 'expectedUpdatedAt']))) return b2bError(res, 400, 'invalid_request', 'unknown group field');
    await run(req, res, state => {
      const owned = ownedGroup(state, req.groupId, coach.id); if (owned.error) return { changed: false, error: owned.error }; const group = owned.group;
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== group.updatedAt) return { changed: false, error: failure(409, 'edit_conflict', 'group was updated by another request') };
      if (group.archivedAt) return { changed: false, error: failure(410, 'group_archived', 'archived group is terminal') };
      if (body.name !== undefined) { const value = clean(body.name, 100, true); if (!value) return { changed: false, error: failure(400, 'invalid_name', 'invalid name') }; group.name = value; }
      if (body.description !== undefined) { const value = clean(body.description, 1000); if (value === null) return { changed: false, error: failure(400, 'invalid_description', 'invalid description') }; group.description = value; }
      if (body.category !== undefined) { const value = clean(body.category, 50, true); if (!value) return { changed: false, error: failure(400, 'invalid_category', 'invalid category') }; group.category = value; }
      if (body.maxMembers !== undefined) { if (!Number.isInteger(body.maxMembers) || body.maxMembers < group.memberCount || body.maxMembers > (limits.maxMembersPerGroup ?? 500)) return { changed: false, error: failure(400, 'invalid_max_members', 'invalid maxMembers') }; group.maxMembers = body.maxMembers; }
      if (body.isPrivate !== undefined) { if (typeof body.isPrivate !== 'boolean') return { changed: false, error: failure(400, 'invalid_privacy', 'isPrivate must be boolean') }; group.isPrivate = body.isPrivate; }
      if (body.archived !== undefined) { if (body.archived !== true) return { changed: false, error: failure(400, 'invalid_archived', 'archived must be true') }; group.archivedAt = new Date(now()).toISOString(); }
      group.updatedAt = new Date(now()).toISOString(); return { changed: true, value: { group: publicGroup(group) }, audit: { event: 'coach.group.update', data: { user: coach, groupId: group.id } } };
    });
  };

  routes['DELETE /api/coach/groups/{groupId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return;
    await run(req, res, state => {
      const owned = ownedGroup(state, req.groupId, coach.id); if (owned.error) return { changed: false, error: owned.error };
      if (state.challenges.some(row => row.groupId === req.groupId && row.status !== 'draft')
          || state.groupPrograms.some(row => row.groupId === req.groupId && row.status !== 'draft')
          || state.groupProgramAdoptions.some(row => row.groupId === req.groupId)) return { changed: false, error: failure(409, 'group_has_history', 'archive groups with published history') };
      const ids = new Set(state.challenges.filter(row => row.groupId === req.groupId).map(row => row.id));
      const programIds = new Set(state.groupPrograms.filter(row => row.groupId === req.groupId).map(row => row.id));
      state.coachGroups = state.coachGroups.filter(row => row.id !== req.groupId); state.groupMembers = state.groupMembers.filter(row => row.groupId !== req.groupId); state.groupInvites = state.groupInvites.filter(row => row.groupId !== req.groupId);
      state.challenges = state.challenges.filter(row => !ids.has(row.id)); state.challengeScores = state.challengeScores.filter(row => !ids.has(row.challengeId)); state.challengeActivityFeed = state.challengeActivityFeed.filter(row => !ids.has(row.challengeId));
      state.groupPrograms = state.groupPrograms.filter(row => !programIds.has(row.id));
      return { changed: true, value: { ok: true, id: req.groupId }, audit: { event: 'coach.group.delete', data: { user: coach, groupId: req.groupId } } };
    });
  };

  routes['GET /api/coach/groups/{groupId}/invite'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach) return; const owned = ownedGroup(db, req.groupId, coach.id); if (owned.error) return b2bError(res, owned.error.status, owned.error.code, owned.error.message);
    const invite = db.groupInvites.find(row => row.groupId === req.groupId && row.status === 'active'); json(res, 200, { invite: invite ? { code: invite.code, expiresAt: invite.expiresAt, status: invite.status } : null });
  };

  routes['POST /api/coach/groups/{groupId}/invite'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    if (!exact(body, new Set(['expiresInDays'])) || body.expiresInDays !== undefined && (!Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 365)) return b2bError(res, 400, 'invalid_invite', 'invalid invite expiration');
    await run(req, res, state => {
      const owned = ownedGroup(state, req.groupId, coach.id); if (owned.error) return { changed: false, error: owned.error }; if (owned.group.archivedAt) return { changed: false, error: failure(410, 'group_archived', 'group is archived') };
      const stamp = new Date(now()).toISOString(); for (const row of state.groupInvites.filter(item => item.groupId === req.groupId && item.status === 'active')) Object.assign(row, { status: 'revoked', revokedAt: stamp, updatedAt: stamp });
      const invite = { id: entityId('ginv', state.groupInvites), groupId: req.groupId, coachId: coach.id, code: newInviteCode(state.groupInvites), status: 'active', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now() + (body.expiresInDays ?? Math.round(inviteTtlMs / 86400000)) * 86400000).toISOString(), revokedAt: null };
      state.groupInvites.push(invite); return { changed: true, value: { invite: { code: invite.code, expiresAt: invite.expiresAt, status: invite.status } }, audit: { event: 'coach.group.invite.rotate', data: { user: coach, groupId: req.groupId } } };
    });
  };

  routes['DELETE /api/coach/groups/{groupId}/invite'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return;
    await run(req, res, state => {
      const owned = ownedGroup(state, req.groupId, coach.id); if (owned.error) return { changed: false, error: owned.error }; const invite = state.groupInvites.find(row => row.groupId === req.groupId && row.status === 'active');
      if (!invite) return { changed: false, error: failure(410, 'invite_revoked', 'invite already revoked') }; const stamp = new Date(now()).toISOString(); Object.assign(invite, { status: 'revoked', revokedAt: stamp, updatedAt: stamp });
      return { changed: true, value: { ok: true }, audit: { event: 'coach.group.invite.revoke', data: { user: coach, groupId: req.groupId } } };
    });
  };

  routes['POST /api/coach/groups/{groupId}/members'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    if (!exact(body, new Set(['athleteId', 'role'])) || typeof body.athleteId !== 'string' || !ID_RE.test(body.athleteId) || body.role !== undefined && !ROLES.has(body.role)) return b2bError(res, 400, 'invalid_member', 'invalid member request');
    await run(req, res, state => {
      const owned = ownedGroup(state, req.groupId, coach.id); if (owned.error) return { changed: false, error: owned.error }; if (owned.group.archivedAt) return { changed: false, error: failure(410, 'group_archived', 'group is archived') };
      const athlete = state.users.find(row => row.id === body.athleteId); if (!athlete) return { changed: false, error: failure(404, 'athlete_not_found', 'athlete not found') };
      if (!activeTrainingLink(state, coach.id, body.athleteId)) return { changed: false, error: failure(403, 'scope_forbidden', 'active training relationship required') };
      const existing = state.groupMembers.find(row => row.groupId === req.groupId && row.athleteId === body.athleteId); if (existing && ['active', 'pending'].includes(existing.status)) return { changed: false, error: failure(409, 'already_member', 'membership already exists') };
      const stamp = new Date(now()).toISOString(), member = existing || { id: entityId('gmem', state.groupMembers), groupId: req.groupId, coachId: coach.id, athleteId: body.athleteId, joinedAt: stamp };
      Object.assign(member, { acceptedAt: null, role: body.role ?? 'member', status: 'pending', updatedAt: stamp }); if (!existing) state.groupMembers.push(member);
      return { changed: true, value: { member: publicMember(member, state, true) }, audit: { event: 'coach.group.member.invite', data: { user: coach, groupId: req.groupId, athleteId: body.athleteId } } };
    }, 201);
  };

  routes['DELETE /api/coach/groups/{groupId}/members/{athleteId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return;
    await run(req, res, state => {
      const owned = ownedGroup(state, req.groupId, coach.id); if (owned.error) return { changed: false, error: owned.error };
      const member = state.groupMembers.find(row => row.groupId === req.groupId && row.athleteId === req.athleteId && ['active', 'pending'].includes(row.status)); if (!member) return { changed: false, error: failure(404, 'member_not_found', 'member not found') };
      const stamp = new Date(now()).toISOString(); if (member.status === 'active') owned.group.memberCount--; member.status = 'removed'; member.updatedAt = stamp; owned.group.updatedAt = stamp;
      return { changed: true, value: { ok: true, status: 'removed' }, audit: { event: 'coach.group.member.remove', data: { user: coach, groupId: req.groupId, athleteId: req.athleteId } } };
    });
  };

  routes['GET /api/athlete/groups'] = async (req, res) => {
    const athlete = athleteOnly(req, res); if (!athlete) return;
    const rows = db.groupMembers.filter(row => row.athleteId === athlete.id && ['active', 'pending'].includes(row.status)).map(member => { const group = db.coachGroups.find(row => row.id === member.groupId); return group && { ...publicGroup(group), myMembership: publicMember(member, db) }; }).filter(Boolean);
    const result = paginate(req, rows, codec, athlete.id, 'athlete-groups'); if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { groups: result.items, page: result.page });
  };

  routes['GET /api/athlete/groups/{groupId}'] = async (req, res) => {
    const athlete = athleteOnly(req, res); if (!athlete) return;
    const member = db.groupMembers.find(row => row.groupId === req.groupId && row.athleteId === athlete.id && row.status === 'active');
    if (!member) return b2bError(res, 404, 'membership_not_found', 'active membership not found');
    const group = db.coachGroups.find(row => row.id === req.groupId); if (!group) return b2bError(res, 404, 'group_not_found', 'group not found'); if (group.archivedAt) return b2bError(res, 410, 'group_archived', 'group is archived');
    const rows = db.groupMembers.filter(row => row.groupId === group.id && row.status === 'active').sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt) || a.id.localeCompare(b.id)).map(row => publicMember(row, db));
    const result = paginate(req, rows, codec, `${athlete.id}:${group.id}`, 'athlete-group-members'); if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error);
    json(res, 200, { group: publicGroup(group), myMembership: publicMember(member, db), members: result.items, page: result.page });
  };

  const activateMembership = async (req, res, athlete, invite) => run(req, res, state => {
    let group;
    if (invite) {
      const row = state.groupInvites.find(item => item.code.toUpperCase() === invite); if (!row) return { changed: false, error: failure(404, 'invite_not_found', 'invite not found') };
      if (row.status === 'revoked') return { changed: false, error: failure(410, 'invite_revoked', 'invite was revoked') }; if (Date.parse(row.expiresAt) <= now()) return { changed: false, error: failure(410, 'invite_expired', 'invite expired') };
      group = state.coachGroups.find(item => item.id === row.groupId);
    } else group = state.coachGroups.find(item => item.id === req.groupId);
    if (!group) return { changed: false, error: failure(404, 'group_not_found', 'group not found') }; if (group.archivedAt) return { changed: false, error: failure(410, 'group_archived', 'group is archived') };
    if (!activeTrainingLink(state, group.coachId, athlete.id)) return { changed: false, error: failure(403, 'scope_forbidden', 'active training relationship required') };
    const existing = state.groupMembers.find(row => row.groupId === group.id && row.athleteId === athlete.id); if (existing?.status === 'active') return { changed: false, error: failure(409, 'already_member', 'already a member') };
    if (!invite && existing?.status !== 'pending') return { changed: false, error: failure(404, 'membership_not_found', 'pending membership not found') };
    if (group.memberCount >= group.maxMembers) return { changed: false, error: failure(409, 'group_full', 'group is full') };
    const stamp = new Date(now()).toISOString(), member = existing || { id: entityId('gmem', state.groupMembers), groupId: group.id, coachId: group.coachId, athleteId: athlete.id, joinedAt: stamp, role: 'member' };
    Object.assign(member, { status: 'active', acceptedAt: stamp, updatedAt: stamp }); if (!existing) state.groupMembers.push(member); group.memberCount++; group.updatedAt = stamp;
    return { changed: true, value: { ok: true, group: publicGroup(group), member: publicMember(member, state) }, audit: { event: invite ? 'athlete.group.join' : 'athlete.group.accept', data: { user: athlete, groupId: group.id } } };
  });

  routes['POST /api/athlete/groups/join'] = async (req, res) => {
    const athlete = athleteOnly(req, res); if (!athlete || throttle(req, res, athlete, true)) return; const body = await readBody(req);
    if (!exact(body, new Set(['inviteCode'])) || typeof body.inviteCode !== 'string' || !body.inviteCode.trim()) return b2bError(res, 400, 'missing_invite_code', 'inviteCode is required');
    await activateMembership(req, res, athlete, body.inviteCode.trim().toUpperCase());
  };
  routes['POST /api/athlete/groups/{groupId}/accept'] = async (req, res) => { const athlete = athleteOnly(req, res); if (!athlete || throttle(req, res, athlete, true)) return; await activateMembership(req, res, athlete, null); };
  routes['POST /api/athlete/groups/{groupId}/leave'] = async (req, res) => {
    const athlete = athleteOnly(req, res); if (!athlete || throttle(req, res, athlete, true)) return;
    await run(req, res, state => { const group = state.coachGroups.find(row => row.id === req.groupId); if (!group) return { changed: false, error: failure(404, 'group_not_found', 'group not found') };
      const member = state.groupMembers.find(row => row.groupId === group.id && row.athleteId === athlete.id && ['active', 'pending'].includes(row.status)); if (!member) return { changed: false, error: failure(404, 'membership_not_found', 'membership not found') };
      const stamp = new Date(now()).toISOString(); if (member.status === 'active') group.memberCount--; member.status = 'left'; member.updatedAt = stamp; group.updatedAt = stamp;
      return { changed: true, value: { ok: true, groupId: group.id, status: 'left' }, audit: { event: 'athlete.group.leave', data: { user: athlete, groupId: group.id } } }; });
  };

  const parseChallenge = (body, state, coach, existing = null) => {
    const allowed = existing ? new Set(['title', 'description', 'startAt', 'endAt', 'timeZone', 'status', 'rules']) : new Set(['title', 'description', 'type', 'scope', 'groupId', 'startAt', 'endAt', 'timeZone', 'status', 'rules']);
    if (!exact(body, allowed)) return { error: failure(400, 'invalid_request', 'unknown challenge field') };
    const title = body.title === undefined && existing ? existing.title : clean(body.title, 100, true);
    const description = body.description === undefined && existing ? existing.description : clean(body.description, 2000);
    const type = existing?.type ?? body.type, scope = existing?.scope ?? body.scope;
    const groupId = existing?.groupId ?? (scope === 'group' ? body.groupId : null);
    const startAt = body.startAt === undefined && existing ? existing.startAt : body.startAt, endAt = body.endAt === undefined && existing ? existing.endAt : body.endAt;
    const timeZone = body.timeZone === undefined && existing ? existing.timeZone : body.timeZone;
    const status = body.status === undefined ? (existing?.status ?? 'draft') : body.status;
    const rules = body.rules === undefined && existing ? existing.rules : rulesFor(type, body.rules);
    if (!title || description === null || !TYPES.has(type) || !SCOPES.has(scope) || !date(startAt) || !date(endAt) || Date.parse(endAt) <= Date.parse(startAt)
        || !validTimeZone(timeZone) || !STATUSES.has(status) || !rules) return { error: failure(400, 'invalid_challenge', 'invalid challenge fields or rules') };
    if (!existing && !['draft', 'active'].includes(status)) return { error: failure(400, 'invalid_status', 'new challenge must be draft or active') };
    if (scope === 'group') { const group = state.coachGroups.find(row => row.id === groupId); if (!group) return { error: failure(404, 'group_not_found', 'group not found') }; if (group.coachId !== coach.id) return { error: failure(403, 'access_denied', 'group belongs to another coach') }; if (group.archivedAt) return { error: failure(410, 'group_archived', 'group is archived') }; }
    else if (groupId !== null) return { error: failure(400, 'invalid_group_id', 'coach_students requires groupId null or absent') };
    return { value: { title, description, type, scope, groupId, startAt: new Date(Date.parse(startAt)).toISOString(), endAt: new Date(Date.parse(endAt)).toISOString(), timeZone, status, rules } };
  };

  routes['POST /api/coach/challenges'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    await run(req, res, state => {
      if (state.challenges.length >= (limits.maxChallenges ?? 5000) || state.challenges.filter(row => row.coachId === coach.id).length >= (limits.maxChallengesPerCoach ?? 100)) return { changed: false, error: failure(409, 'challenge_limit_reached', 'challenge quota reached') };
      const parsed = parseChallenge(body, state, coach); if (parsed.error) return { changed: false, error: parsed.error };
      const stamp = new Date(now()).toISOString(), challenge = { id: entityId('chal', state.challenges), coachId: coach.id, ...parsed.value, participantIds: [], createdAt: stamp, updatedAt: stamp, activatedAt: null, completedAt: null, archivedAt: null };
      if (challenge.status === 'active') { challenge.participantIds = currentEligibleIds(state, challenge); challenge.activatedAt = stamp; }
      state.challenges.push(challenge); return { changed: true, value: { challenge: publicChallenge(challenge, now()) }, audit: { event: 'coach.challenge.create', data: { user: coach, challengeId: challenge.id } } };
    }, 201);
  };

  routes['GET /api/coach/challenges'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach) return; const result = paginate(req, db.challenges.filter(row => row.coachId === coach.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(row => publicChallenge(row, now())), codec, coach.id, 'coach-challenges');
    if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { challenges: result.items, page: result.page });
  };
  routes['GET /api/coach/challenges/{challengeId}'] = async (req, res) => { const coach = coachOnly(req, res); if (!coach) return; const challenge = db.challenges.find(row => row.id === req.challengeId); if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found'); if (challenge.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied'); json(res, 200, { challenge: publicChallenge(challenge, now()) }); };

  routes['PUT /api/coach/challenges/{challengeId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    await run(req, res, state => {
      const challenge = state.challenges.find(row => row.id === req.challengeId); if (!challenge) return { changed: false, error: failure(404, 'challenge_not_found', 'challenge not found') }; if (challenge.coachId !== coach.id) return { changed: false, error: failure(403, 'access_denied', 'access denied') };
      const current = effectiveStatus(challenge, now()); if (current === 'completed' && challenge.status === 'active') { challenge.status = 'completed'; challenge.completedAt = new Date(now()).toISOString(); }
      const target = body.status ?? challenge.status, transitions = { draft: new Set(['draft', 'active']), active: new Set(['active', 'completed', 'archived']), completed: new Set(['completed', 'archived']), archived: new Set(['archived']) };
      if (!transitions[challenge.status].has(target)) return { changed: false, error: failure(409, 'invalid_transition', 'invalid challenge lifecycle transition') };
      if (challenge.status !== 'draft' && Object.keys(body).some(key => key !== 'status')) return { changed: false, error: failure(409, 'challenge_immutable', 'published challenge configuration is immutable') };
      const parsed = parseChallenge(body, state, coach, challenge); if (parsed.error) return { changed: false, error: parsed.error }; const stamp = new Date(now()).toISOString(), previous = challenge.status;
      Object.assign(challenge, parsed.value, { updatedAt: stamp });
      if (previous === 'draft' && target === 'active') { challenge.participantIds = currentEligibleIds(state, challenge); challenge.activatedAt = stamp; }
      if (previous === 'active' && ['completed', 'archived'].includes(target)) {
        const calculated = calculateChallengeLeaderboard(challenge, { db: state, readState, nowMs: now() });
        state.challengeScores = state.challengeScores.filter(row => row.challengeId !== challenge.id);
        for (const row of calculated.leaderboard) state.challengeScores.push({ id: entityId('cscr', state.challengeScores), challengeId: challenge.id, athleteId: row.athleteId, score: row.score, workoutsCount: row.workoutsCount, volumeLoad: row.volumeLoad, habitCheckinsCount: row.habitCheckinsCount, lastActivityAt: row.lastActivityAt, updatedAt: stamp, finalized: true });
        state.challengeActivityFeed = state.challengeActivityFeed.filter(row => row.challengeId !== challenge.id).concat(calculated.activityFeed.slice(0, limits.maxActivityFeedPerChallenge ?? 1000).map(row => ({ ...row, finalized: true })));
        challenge.completedAt = stamp;
      }
      if (target === 'archived') challenge.archivedAt = stamp;
      return { changed: true, value: { challenge: publicChallenge(challenge, now()) }, audit: { event: 'coach.challenge.update', data: { user: coach, challengeId: challenge.id } } };
    });
  };

  routes['DELETE /api/coach/challenges/{challengeId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return;
    await run(req, res, state => { const challenge = state.challenges.find(row => row.id === req.challengeId); if (!challenge) return { changed: false, error: failure(404, 'challenge_not_found', 'challenge not found') }; if (challenge.coachId !== coach.id) return { changed: false, error: failure(403, 'access_denied', 'access denied') }; if (challenge.status !== 'draft') return { changed: false, error: failure(409, 'challenge_has_history', 'only drafts can be deleted') }; state.challenges = state.challenges.filter(row => row.id !== challenge.id); return { changed: true, value: { ok: true, id: challenge.id }, audit: { event: 'coach.challenge.delete', data: { user: coach, challengeId: challenge.id } } }; });
  };

  routes['POST /api/coach/challenges/{challengeId}/points'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req), key = req.headers['idempotency-key'];
    if (!exact(body, new Set(['athleteId', 'points', 'reason', 'correctionOf'])) || typeof body.athleteId !== 'string' || !ID_RE.test(body.athleteId) || !number(body.points, -10000, 10000) || body.points === 0
        || !clean(body.reason, 500, true) || body.correctionOf !== undefined && (typeof body.correctionOf !== 'string' || !ID_RE.test(body.correctionOf)) || typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(key)) return b2bError(res, 400, 'invalid_adjustment', 'valid athleteId, points, reason and Idempotency-Key are required');
    await run(req, res, state => {
      const challenge = state.challenges.find(row => row.id === req.challengeId); if (!challenge) return { changed: false, error: failure(404, 'challenge_not_found', 'challenge not found') }; if (challenge.coachId !== coach.id) return { changed: false, error: failure(403, 'access_denied', 'access denied') };
      if (challenge.type !== 'custom_points') return { changed: false, error: failure(422, 'custom_points_required', 'challenge does not accept custom points') }; if (effectiveStatus(challenge, now()) !== 'active') return { changed: false, error: failure(410, 'challenge_ended', 'challenge is not active') }; if (!challengeAllowsAthlete(state, challenge, body.athleteId)) return { changed: false, error: failure(403, 'athlete_ineligible', 'athlete is not a participant') };
      if (now() < Date.parse(challenge.startAt)) return { changed: false, error: failure(409, 'challenge_not_started', 'challenge has not started') };
      const duplicate = state.challengeActivityFeed.find(row => row.challengeId === challenge.id && row.idempotencyKey === key);
      if (duplicate) {
        const correctionMatches = body.correctionOf === undefined
          ? !state.challengeActivityFeed.some(row => row.id === duplicate.sourceId && row.challengeId === challenge.id)
          : duplicate.sourceId === body.correctionOf;
        if (duplicate.athleteId !== body.athleteId || duplicate.pointsAwarded !== body.points || duplicate.reason !== body.reason.trim() || !correctionMatches) return { changed: false, error: failure(409, 'idempotency_conflict', 'Idempotency-Key was already used for another adjustment') };
        const score = state.challengeScores.find(row => row.challengeId === challenge.id && row.athleteId === body.athleteId); return { changed: false, value: { adjustment: { id: duplicate.id, points: duplicate.pointsAwarded, timestamp: duplicate.timestamp }, score: score?.score ?? 0, idempotent: true } };
      }
      if (Math.abs(body.points) > challenge.rules.maxPointsPerAdjustment) return { changed: false, error: failure(422, 'points_out_of_range', 'points exceed adjustment limit') };
      let correction = null;
      if (body.correctionOf !== undefined) {
        correction = state.challengeActivityFeed.find(row => row.challengeId === challenge.id && row.id === body.correctionOf && row.activityType === 'custom_adjustment');
        if (!correction) return { changed: false, error: failure(422, 'correction_not_found', 'correction target not found') };
        if (correction.athleteId !== body.athleteId || body.points !== -correction.pointsAwarded || state.challengeActivityFeed.some(row => row.challengeId === challenge.id && row.sourceId === correction.id)) return { changed: false, error: failure(422, 'invalid_correction', 'correction must compensate one uncorrected adjustment for the same athlete') };
      }
      const stamp = new Date(now()).toISOString(); let score = state.challengeScores.find(row => row.challengeId === challenge.id && row.athleteId === body.athleteId);
      if (!score) { score = { id: entityId('cscr', state.challengeScores), challengeId: challenge.id, athleteId: body.athleteId, score: 0, workoutsCount: 0, volumeLoad: 0, habitCheckinsCount: 0, lastActivityAt: null, updatedAt: stamp, finalized: false }; state.challengeScores.push(score); }
      const next = score.score + body.points; if (Math.abs(next) > (challenge.rules.maxAbsoluteScore ?? 1000000)) return { changed: false, error: failure(422, 'score_out_of_range', 'resulting score exceeds limit') };
      Object.assign(score, { score: Math.round(next * 1000) / 1000, lastActivityAt: stamp, updatedAt: stamp });
      const feed = { id: entityId('caft', state.challengeActivityFeed), challengeId: challenge.id, athleteId: body.athleteId, activityType: 'custom_adjustment', sourceId: correction?.id ?? entityId('adj', state.challengeActivityFeed), description: correction ? 'Correção de pontuação' : 'Ajuste de pontuação', pointsAwarded: body.points, timestamp: stamp, reason: body.reason.trim(), idempotencyKey: key, createdAt: stamp, finalized: false };
      state.challengeActivityFeed.push(feed); return { changed: true, value: { adjustment: { id: feed.id, points: feed.pointsAwarded, timestamp: feed.timestamp }, score: score.score, idempotent: false }, audit: { event: 'coach.challenge.points.adjust', data: { user: coach, challengeId: challenge.id, athleteId: body.athleteId, reason: feed.reason, idempotencyKey: key } } };
    });
  };

  const leaderboardResponse = (req, result, viewerId) => {
    const tenant = `${result.challenge.id}:${viewerId || 'coach'}`;
    const board = paginate(req, result.leaderboard.map(({ athleteId, ...row }) => ({ ...row, isMe: athleteId === viewerId })), codec, tenant, 'leaderboard');
    const feedRows = result.activityFeed.map(row => ({ id: row.id, participantKey: participantKey(row.challengeId, row.athleteId), displayName: nameOf(db.users.find(user => user.id === row.athleteId)), activityType: row.activityType, description: row.description, pointsAwarded: row.pointsAwarded, timestamp: row.timestamp, isMe: row.athleteId === viewerId }));
    const feed = paginate(req, feedRows, codec, tenant, 'feed', 'feed');
    if (board.error || feed.error) return { error: board.error || feed.error };
    return { challenge: result.challenge, leaderboard: board.items, activityFeed: feed.items, page: board.page, feedPage: feed.page };
  };

  routes['GET /api/coach/challenges/{challengeId}/leaderboard'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach) return; const challenge = db.challenges.find(row => row.id === req.challengeId); if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found'); if (challenge.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');
    const output = leaderboardResponse(req, calculateChallengeLeaderboard(challenge, { db, readState, nowMs: now() }), null); if (output.error) return b2bError(res, 400, 'invalid_pagination', output.error); json(res, 200, output);
  };
  routes['GET /api/athlete/challenges'] = async (req, res) => {
    const athlete = athleteOnly(req, res); if (!athlete) return; const result = paginate(req, db.challenges.filter(row => !['draft', 'archived'].includes(row.status) && challengeAllowsAthlete(db, row, athlete.id)).sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt)).map(row => publicChallenge(row, now())), codec, athlete.id, 'athlete-challenges');
    if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { challenges: result.items, page: result.page });
  };
  routes['GET /api/athlete/challenges/{challengeId}'] = async (req, res) => { const athlete = athleteOnly(req, res); if (!athlete) return; const challenge = db.challenges.find(row => row.id === req.challengeId && row.status !== 'draft'); if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found'); if (!challengeAllowsAthlete(db, challenge, athlete.id)) return b2bError(res, 403, 'access_denied', 'not a participant'); json(res, 200, { challenge: publicChallenge(challenge, now()) }); };
  routes['GET /api/athlete/challenges/{challengeId}/leaderboard'] = async (req, res) => {
    const athlete = athleteOnly(req, res); if (!athlete) return; const challenge = db.challenges.find(row => row.id === req.challengeId && row.status !== 'draft'); if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found'); if (!challengeAllowsAthlete(db, challenge, athlete.id)) return b2bError(res, 403, 'access_denied', 'not a participant');
    const output = leaderboardResponse(req, calculateChallengeLeaderboard(challenge, { db, readState, nowMs: now() }), athlete.id); if (output.error) return b2bError(res, 400, 'invalid_pagination', output.error); json(res, 200, output);
  };

  return routes;
}
