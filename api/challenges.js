import crypto from 'node:crypto';
import { createWindow } from './rate-limit.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const CHALLENGE_TYPES = new Set(['workouts_count', 'habits_consistency', 'volume_load', 'custom_points']);
const CHALLENGE_SCOPES = new Set(['group', 'coach_students']);
const CHALLENGE_STATUSES = new Set(['draft', 'active', 'completed', 'archived']);
const MEMBER_ROLES = new Set(['member', 'moderator']);
const MEMBER_STATUSES = new Set(['active', 'removed', 'left']);

export const CHALLENGE_LIMITS = Object.freeze({
  maxGroupsPerCoach: 50,
  maxGroups: 5000,
  maxMembersPerGroup: 500,
  maxChallengesPerCoach: 100,
  maxChallenges: 5000,
  maxScoresPerChallenge: 2000,
  maxActivityFeedPerChallenge: 1000,
  maxActivityFeed: 50000,
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function makeEntityId(prefix, rows = []) {
  let id;
  const existing = new Set(rows.map(r => r?.id));
  do {
    id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
  } while (existing.has(id));
  return id;
}

function generateInviteCode(existingGroups = []) {
  const existing = new Set(existingGroups.map(g => (g?.inviteCode || '').toUpperCase()));
  let code;
  do {
    code = `GRP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  } while (existing.has(code));
  return code;
}

export function validateChallengesState(db, limits = CHALLENGE_LIMITS) {
  for (const key of ['coachGroups', 'groupMembers', 'challenges', 'challengeScores', 'challengeActivityFeed']) {
    if (db[key] === undefined) db[key] = [];
    if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  }

  const usersMap = Array.isArray(db.users) && db.users.length > 0 ? new Map(db.users.map(u => [u.id, u])) : null;
  const groupsMap = new Map();
  const activeMembersByGroup = new Map();

  for (const group of db.coachGroups) {
    if (!record(group)) throw new Error('coachGroups contains an invalid record');
    if (typeof group.id !== 'string' || !ID_RE.test(group.id)) throw new Error('coachGroups contains an invalid id');
    if (groupsMap.has(group.id)) throw new Error(`duplicate coachGroups id ${group.id}`);
    groupsMap.set(group.id, group);

    if (typeof group.coachId !== 'string' || !ID_RE.test(group.coachId)) throw new Error('coachGroups contains an invalid coachId');
    if (usersMap) {
      const coach = usersMap.get(group.coachId);
      if (!coach || coach.profile?.kind !== 'coach') throw new Error(`coachGroups coachId ${group.coachId} is not a valid coach`);
    }

    if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 100) {
      throw new Error('coachGroups contains an invalid name');
    }
    if (typeof group.description !== 'string' || group.description.length > 1000) {
      throw new Error('coachGroups contains an invalid description');
    }
    if (typeof group.category !== 'string' || !group.category.trim() || group.category.length > 50) {
      throw new Error('coachGroups contains an invalid category');
    }
    if (!Number.isInteger(group.maxMembers) || group.maxMembers < 1 || group.maxMembers > (limits.maxMembersPerGroup ?? 500)) {
      throw new Error('coachGroups contains an invalid maxMembers');
    }
    if (typeof group.isPrivate !== 'boolean') {
      throw new Error('coachGroups contains an invalid isPrivate');
    }
    if (typeof group.inviteCode !== 'string' || !group.inviteCode.trim() || group.inviteCode.length > 30) {
      throw new Error('coachGroups contains an invalid inviteCode');
    }
    if (!Number.isInteger(group.memberCount) || group.memberCount < 0) {
      throw new Error('coachGroups contains an invalid memberCount');
    }
    if (!Number.isFinite(Date.parse(group.createdAt)) || !Number.isFinite(Date.parse(group.updatedAt))) {
      throw new Error('coachGroups contains an invalid timestamp');
    }
    if (group.archivedAt !== null && !Number.isFinite(Date.parse(group.archivedAt))) {
      throw new Error('coachGroups contains an invalid archivedAt');
    }
  }

  const memberIds = new Set();
  const activePairSet = new Set();

  for (const member of db.groupMembers) {
    if (!record(member)) throw new Error('groupMembers contains an invalid record');
    if (typeof member.id !== 'string' || !ID_RE.test(member.id)) throw new Error('groupMembers contains an invalid id');
    if (memberIds.has(member.id)) throw new Error(`duplicate groupMembers id ${member.id}`);
    memberIds.add(member.id);

    if (typeof member.groupId !== 'string' || !groupsMap.has(member.groupId)) {
      throw new Error(`groupMembers groupId ${member.groupId} does not exist`);
    }
    const group = groupsMap.get(member.groupId);
    if (member.coachId !== group.coachId) {
      throw new Error(`groupMembers coachId ${member.coachId} does not match group owner ${group.coachId}`);
    }
    if (typeof member.athleteId !== 'string' || !ID_RE.test(member.athleteId)) {
      throw new Error('groupMembers contains an invalid athleteId');
    }
    if (usersMap) {
      const athlete = usersMap.get(member.athleteId);
      if (!athlete || athlete.profile?.kind === 'coach') {
        throw new Error(`groupMembers athleteId ${member.athleteId} is not a valid athlete`);
      }
    }
    if (!MEMBER_ROLES.has(member.role)) throw new Error(`groupMembers invalid role ${member.role}`);
    if (!MEMBER_STATUSES.has(member.status)) throw new Error(`groupMembers invalid status ${member.status}`);
    if (!Number.isFinite(Date.parse(member.joinedAt))) throw new Error('groupMembers contains an invalid joinedAt');

    if (member.status === 'active') {
      const pair = `${member.groupId}:${member.athleteId}`;
      if (activePairSet.has(pair)) throw new Error(`duplicate active membership for ${pair}`);
      activePairSet.add(pair);
      activeMembersByGroup.set(member.groupId, (activeMembersByGroup.get(member.groupId) || 0) + 1);
    }
  }

  for (const [groupId, count] of activeMembersByGroup.entries()) {
    const group = groupsMap.get(groupId);
    if (group && count > group.maxMembers) {
      throw new Error(`active groupMembers count ${count} exceeds group maxMembers ${group.maxMembers}`);
    }
  }

  const challengesMap = new Map();
  for (const challenge of db.challenges) {
    if (!record(challenge)) throw new Error('challenges contains an invalid record');
    if (typeof challenge.id !== 'string' || !ID_RE.test(challenge.id)) throw new Error('challenges contains an invalid id');
    if (challengesMap.has(challenge.id)) throw new Error(`duplicate challenges id ${challenge.id}`);
    challengesMap.set(challenge.id, challenge);

    if (typeof challenge.coachId !== 'string' || !ID_RE.test(challenge.coachId)) throw new Error('challenges contains an invalid coachId');
    if (usersMap) {
      const coach = usersMap.get(challenge.coachId);
      if (!coach || coach.profile?.kind !== 'coach') throw new Error(`challenges coachId ${challenge.coachId} is not a valid coach`);
    }

    if (!CHALLENGE_TYPES.has(challenge.type)) throw new Error(`challenges invalid type ${challenge.type}`);
    if (!CHALLENGE_SCOPES.has(challenge.scope)) throw new Error(`challenges invalid scope ${challenge.scope}`);

    if (challenge.scope === 'group') {
      if (typeof challenge.groupId !== 'string' || !groupsMap.has(challenge.groupId)) {
        throw new Error(`challenges scope is group but groupId ${challenge.groupId} does not exist`);
      }
      const group = groupsMap.get(challenge.groupId);
      if (group.coachId !== challenge.coachId) {
        throw new Error(`challenges coachId ${challenge.coachId} does not match group owner ${group.coachId}`);
      }
    } else if (challenge.groupId !== null && challenge.groupId !== undefined && typeof challenge.groupId !== 'string') {
      throw new Error('challenges groupId must be a string or null');
    }

    const title = challenge.name || challenge.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 100) {
      throw new Error('challenges contains an invalid name/title');
    }
    if (typeof challenge.description !== 'string' || challenge.description.length > 2000) {
      throw new Error('challenges contains an invalid description');
    }

    const startMs = Date.parse(challenge.startAt);
    const endMs = Date.parse(challenge.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('challenges contains an invalid date range');
    if (endMs <= startMs) throw new Error('challenges endAt must be after startAt');

    if (!validTimeZone(challenge.timeZone)) throw new Error(`challenges invalid timeZone ${challenge.timeZone}`);
    if (!CHALLENGE_STATUSES.has(challenge.status)) throw new Error(`challenges invalid status ${challenge.status}`);
    if (!record(challenge.rules)) throw new Error('challenges rules must be an object');

    if (!Number.isFinite(Date.parse(challenge.createdAt)) || !Number.isFinite(Date.parse(challenge.updatedAt))) {
      throw new Error('challenges contains an invalid timestamp');
    }
  }

  const scoreIds = new Set();
  for (const score of db.challengeScores) {
    if (!record(score)) throw new Error('challengeScores contains an invalid record');
    if (typeof score.id !== 'string' || !ID_RE.test(score.id)) throw new Error('challengeScores contains an invalid id');
    if (scoreIds.has(score.id)) throw new Error(`duplicate challengeScores id ${score.id}`);
    scoreIds.add(score.id);

    if (typeof score.challengeId !== 'string' || !challengesMap.has(score.challengeId)) {
      throw new Error(`challengeScores challengeId ${score.challengeId} does not exist`);
    }
    if (typeof score.athleteId !== 'string' || !ID_RE.test(score.athleteId)) {
      throw new Error('challengeScores contains an invalid athleteId');
    }
    if (typeof score.score !== 'number' || !Number.isFinite(score.score)) {
      throw new Error('challengeScores score must be a finite number');
    }
  }

  const feedIds = new Set();
  for (const feed of db.challengeActivityFeed) {
    if (!record(feed)) throw new Error('challengeActivityFeed contains an invalid record');
    if (typeof feed.id !== 'string' || !ID_RE.test(feed.id)) throw new Error('challengeActivityFeed contains an invalid id');
    if (feedIds.has(feed.id)) throw new Error(`duplicate challengeActivityFeed id ${feed.id}`);
    feedIds.add(feed.id);

    if (typeof feed.challengeId !== 'string' || !challengesMap.has(feed.challengeId)) {
      throw new Error(`challengeActivityFeed challengeId ${feed.challengeId} does not exist`);
    }
    if (typeof feed.athleteId !== 'string' || !ID_RE.test(feed.athleteId)) {
      throw new Error('challengeActivityFeed contains an invalid athleteId');
    }
    if (!Number.isFinite(Date.parse(feed.timestamp))) {
      throw new Error('challengeActivityFeed contains an invalid timestamp');
    }
    if (typeof feed.pointsAwarded !== 'number' || !Number.isFinite(feed.pointsAwarded)) {
      throw new Error('challengeActivityFeed pointsAwarded must be a finite number');
    }
  }

  return true;
}

export function compactChallengesState(db, limits = CHALLENGE_LIMITS, nowMs = Date.now()) {
  db.coachGroups ||= [];
  db.groupMembers ||= [];
  db.challenges ||= [];
  db.challengeScores ||= [];
  db.challengeActivityFeed ||= [];

  let changed = false;
  const beforeCounts = [
    db.coachGroups.length, db.groupMembers.length, db.challenges.length,
    db.challengeScores.length, db.challengeActivityFeed.length,
  ];

  // Reconcile group memberCounts
  for (const group of db.coachGroups) {
    const activeCount = db.groupMembers.filter(m => m.groupId === group.id && m.status === 'active').length;
    if (group.memberCount !== activeCount) {
      group.memberCount = activeCount;
      changed = true;
    }
  }

  // Cap activity feed per challenge
  const maxFeedPerChallenge = limits.maxActivityFeedPerChallenge ?? 1000;
  const maxFeedOverall = limits.maxActivityFeed ?? 50000;
  const feedByChallenge = new Map();
  for (const feed of db.challengeActivityFeed) {
    const list = feedByChallenge.get(feed.challengeId) || [];
    list.push(feed);
    feedByChallenge.set(feed.challengeId, list);
  }

  const keptFeeds = [];
  for (const list of feedByChallenge.values()) {
    list.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || String(a.id).localeCompare(String(b.id)));
    keptFeeds.push(...list.slice(0, maxFeedPerChallenge));
  }

  keptFeeds.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || String(a.id).localeCompare(String(b.id)));
  db.challengeActivityFeed = keptFeeds.slice(0, maxFeedOverall);

  // Check capacity limits
  const activeGroups = db.coachGroups.filter(g => !g.archivedAt);
  if (activeGroups.length > (limits.maxGroups ?? 5000)) {
    throw new Error(`coachGroups exceed configured limit ${limits.maxGroups ?? 5000}`);
  }
  const activeChallenges = db.challenges.filter(c => c.status !== 'archived');
  if (activeChallenges.length > (limits.maxChallenges ?? 5000)) {
    throw new Error(`challenges exceed configured limit ${limits.maxChallenges ?? 5000}`);
  }

  changed = changed || beforeCounts.some((cnt, i) => cnt !== [
    db.coachGroups.length, db.groupMembers.length, db.challenges.length,
    db.challengeScores.length, db.challengeActivityFeed.length,
  ][i]);

  return { changed };
}

export function removeChallengesUser(db, userId) {
  db.coachGroups ||= [];
  db.groupMembers ||= [];
  db.challenges ||= [];
  db.challengeScores ||= [];
  db.challengeActivityFeed ||= [];

  const coachGroupIds = new Set(db.coachGroups.filter(g => g.coachId === userId).map(g => g.id));
  const coachChallengeIds = new Set(db.challenges.filter(c => c.coachId === userId).map(c => c.id));

  // If athlete was member of groups, track groups to recompute memberCounts
  const athleteMemberships = db.groupMembers.filter(m => m.athleteId === userId && m.status === 'active');
  const affectedGroupIds = new Set(athleteMemberships.map(m => m.groupId));

  // Purge group memberships
  db.groupMembers = db.groupMembers.filter(m =>
    !coachGroupIds.has(m.groupId) && m.coachId !== userId && m.athleteId !== userId
  );

  // Update memberCount for affected groups
  for (const group of db.coachGroups) {
    if (affectedGroupIds.has(group.id)) {
      group.memberCount = db.groupMembers.filter(m => m.groupId === group.id && m.status === 'active').length;
    }
  }

  // Purge challenges
  db.challenges = db.challenges.filter(c => c.coachId !== userId && !coachGroupIds.has(c.groupId));

  // Purge coach groups
  db.coachGroups = db.coachGroups.filter(g => g.coachId !== userId);

  // Purge challenge scores & feeds
  db.challengeScores = db.challengeScores.filter(s =>
    !coachChallengeIds.has(s.challengeId) && s.athleteId !== userId
  );
  db.challengeActivityFeed = db.challengeActivityFeed.filter(f =>
    !coachChallengeIds.has(f.challengeId) && f.athleteId !== userId
  );
}

export function calculateChallengeLeaderboard(challenge, { db, readState = () => null, nowMs = Date.now() }) {
  const usersMap = Array.isArray(db.users) ? new Map(db.users.map(u => [u.id, u])) : new Map();

  let athleteIds = [];
  if (challenge.scope === 'group') {
    athleteIds = (db.groupMembers || [])
      .filter(m => m.groupId === challenge.groupId && m.status === 'active')
      .map(m => m.athleteId);
  } else {
    // coach_students
    const studentIds = (db.coachAthleteLinks || [])
      .filter(l => l.coachId === challenge.coachId && l.status === 'active')
      .map(l => l.athleteId);
    const groupMemberIds = (db.groupMembers || [])
      .filter(m => m.coachId === challenge.coachId && m.status === 'active')
      .map(m => m.athleteId);
    athleteIds = [...new Set([...studentIds, ...groupMemberIds])];
  }

  const startMs = Date.parse(challenge.startAt);
  const endMs = Date.parse(challenge.endAt);
  const startDateStr = challenge.startAt.slice(0, 10);
  const endDateStr = challenge.endAt.slice(0, 10);

  const leaderboardEntries = [];

  for (const athleteId of athleteIds) {
    const user = usersMap.get(athleteId);
    const athleteName = user?.name || 'Atleta';
    const state = readState(athleteId) || {};

    const workouts = (Array.isArray(state.workouts) ? state.workouts : []).filter(w => {
      if (!w) return false;
      const wDate = typeof w.d === 'string' ? w.d : null;
      const wStart = Number.isFinite(w.start) ? w.start : null;
      if (wDate && (wDate < startDateStr || wDate > endDateStr)) return false;
      if (wStart && (wStart < startMs || wStart > endMs)) return false;
      return true;
    });

    const checkins = (Array.isArray(db.habitCheckins) ? db.habitCheckins : []).filter(c => {
      if (!c || c.athleteId !== athleteId || !c.completed) return false;
      const cDate = typeof c.date === 'string' ? c.date : null;
      const cMs = Date.parse(c.updatedAt || c.date);
      if (cDate && (cDate < startDateStr || cDate > endDateStr)) return false;
      if (Number.isFinite(cMs) && (cMs < startMs || cMs > endMs)) return false;
      return true;
    });

    let score = 0;
    let workoutsCount = workouts.length;
    let volumeLoad = workouts.reduce((sum, w) => sum + (Number(w.vol) || 0), 0);
    let habitCheckinsCount = checkins.length;
    let lastActivityAt = null;

    if (challenge.type === 'workouts_count') {
      const pointsPerWorkout = challenge.rules?.pointsPerWorkout || 1;
      score = workoutsCount * pointsPerWorkout;
      if (workouts.length) {
        const sorted = [...workouts].sort((a, b) => {
          const aTime = a.start || Date.parse(a.d + 'T12:00:00Z') || 0;
          const bTime = b.start || Date.parse(b.d + 'T12:00:00Z') || 0;
          return bTime - aTime;
        });
        const latest = sorted[0];
        lastActivityAt = latest.start ? new Date(latest.start).toISOString() : (latest.d ? `${latest.d}T12:00:00.000Z` : null);
      }
    } else if (challenge.type === 'volume_load') {
      score = Math.round(volumeLoad);
      const withVol = workouts.filter(w => (Number(w.vol) || 0) > 0);
      if (withVol.length) {
        const sorted = [...withVol].sort((a, b) => {
          const aTime = a.start || Date.parse(a.d + 'T12:00:00Z') || 0;
          const bTime = b.start || Date.parse(b.d + 'T12:00:00Z') || 0;
          return bTime - aTime;
        });
        const latest = sorted[0];
        lastActivityAt = latest.start ? new Date(latest.start).toISOString() : (latest.d ? `${latest.d}T12:00:00.000Z` : null);
      }
    } else if (challenge.type === 'habits_consistency') {
      const pointsPerHabit = challenge.rules?.pointsPerHabit || 1;
      score = habitCheckinsCount * pointsPerHabit;
      if (checkins.length) {
        const sorted = [...checkins].sort((a, b) => Date.parse(b.updatedAt || b.date) - Date.parse(a.updatedAt || a.date));
        lastActivityAt = sorted[0].updatedAt || `${sorted[0].date}T12:00:00.000Z`;
      }
    } else if (challenge.type === 'custom_points') {
      const ptsWorkout = challenge.rules?.pointsPerWorkout ?? 10;
      const ptsHabit = challenge.rules?.pointsPerHabit ?? 2;
      const storedScore = (db.challengeScores || []).find(s => s.challengeId === challenge.id && s.athleteId === athleteId);
      const manual = Number(storedScore?.customPoints || 0);
      score = (workoutsCount * ptsWorkout) + (habitCheckinsCount * ptsHabit) + manual;

      const timestamps = [];
      for (const w of workouts) {
        const t = w.start || (w.d ? Date.parse(w.d + 'T12:00:00Z') : null);
        if (t) timestamps.push(t);
      }
      for (const c of checkins) {
        const t = Date.parse(c.updatedAt || c.date);
        if (t) timestamps.push(t);
      }
      if (timestamps.length) {
        timestamps.sort((a, b) => b - a);
        lastActivityAt = new Date(timestamps[0]).toISOString();
      }
    }

    leaderboardEntries.push({
      athleteId,
      athleteName,
      score,
      workoutsCount,
      volumeLoad: Math.round(volumeLoad),
      habitCheckinsCount,
      lastActivityAt,
    });
  }

  // Deterministic sort:
  // 1. Score descending
  // 2. Earliest lastActivityAt first (who completed first). Active beats inactive (null).
  // 3. athleteId ascending
  leaderboardEntries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.lastActivityAt && !b.lastActivityAt) return -1;
    if (!a.lastActivityAt && b.lastActivityAt) return 1;
    if (a.lastActivityAt && b.lastActivityAt && a.lastActivityAt !== b.lastActivityAt) {
      return a.lastActivityAt.localeCompare(b.lastActivityAt);
    }
    return a.athleteId.localeCompare(b.athleteId);
  });

  const rankedLeaderboard = leaderboardEntries.map((entry, idx) => ({
    ...entry,
    rank: idx + 1,
  }));

  const activityFeed = (db.challengeActivityFeed || [])
    .filter(f => f.challengeId === challenge.id)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 50);

  return {
    challenge,
    leaderboard: rankedLeaderboard,
    activityFeed,
  };
}

export function createChallengeRoutes(context) {
  const {
    audit, auditDenied, b2bError, db, json, limitAddress,
    limits: configuredLimits = {}, makeEntityId: makeEntityIdCtx,
    profileOf, readBody, readSession, readState = () => null,
    rate = {}, saveDb, publishDb, commitCandidate,
    now = () => Date.now(),
  } = context;

  const limits = { ...CHALLENGE_LIMITS, ...configuredLimits };
  const genId = (prefix, rows) => makeEntityIdCtx ? makeEntityIdCtx(prefix, rows) : makeEntityId(prefix, rows);

  const commit = async (candidate, base = db) => {
    validateChallengesState(candidate, limits);
    if (typeof commitCandidate === 'function') {
      await commitCandidate(candidate, base);
    } else {
      saveDb(candidate);
      if (typeof publishDb === 'function') publishDb(candidate);
    }
  };

  const coachOnly = (req, res) => {
    const user = readSession(req);
    if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(user).kind !== 'coach') { b2bError(res, 403, 'role_forbidden', 'professional profile required'); return null; }
    return user;
  };

  const athleteOnly = (req, res) => {
    const user = readSession(req);
    if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(user).kind === 'coach') { b2bError(res, 403, 'role_forbidden', 'athlete profile required'); return null; }
    return user;
  };

  return {
    // -------------------------------------------------------------
    // Coach Group Routes
    // -------------------------------------------------------------

    'POST /api/coach/groups': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const body = await readBody(req);

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 100) {
        return b2bError(res, 400, 'invalid_name', 'name is required and must be under 100 characters');
      }

      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (description.length > 1000) {
        return b2bError(res, 400, 'invalid_description', 'description must be under 1000 characters');
      }

      const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'geral';
      if (category.length > 50) {
        return b2bError(res, 400, 'invalid_category', 'category must be under 50 characters');
      }

      const maxMembers = Number.isInteger(body.maxMembers) ? body.maxMembers : 50;
      if (maxMembers < 1 || maxMembers > (limits.maxMembersPerGroup ?? 500)) {
        return b2bError(res, 400, 'invalid_max_members', `maxMembers must be between 1 and ${limits.maxMembersPerGroup ?? 500}`);
      }

      const isPrivate = Boolean(body.isPrivate);

      const coachGroupCount = db.coachGroups.filter(g => g.coachId === coach.id && !g.archivedAt).length;
      if (coachGroupCount >= (limits.maxGroupsPerCoach ?? 50)) {
        return b2bError(res, 409, 'group_limit_reached', 'maximum number of active groups reached for this coach');
      }

      const nowIso = new Date(now()).toISOString();
      const group = {
        id: genId('cgrp', db.coachGroups),
        coachId: coach.id,
        name,
        description,
        category,
        maxMembers,
        isPrivate,
        inviteCode: generateInviteCode(db.coachGroups),
        memberCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        archivedAt: null,
      };

      const candidate = structuredClone(db);
      candidate.coachGroups ||= [];
      candidate.coachGroups.push(group);

      try {
        await commit(candidate);
        audit?.(req, 'coach.group.create', { user: coach, groupId: group.id });
        json(res, 201, { group });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'GET /api/coach/groups': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const groups = (db.coachGroups || [])
        .filter(g => g.coachId === coach.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      json(res, 200, { groups });
    },

    'GET /api/coach/groups/{groupId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const group = (db.coachGroups || []).find(g => g.id === req.groupId);
      if (!group) return b2bError(res, 404, 'group_not_found', 'group not found');
      if (group.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'group does not belong to this coach');

      const usersMap = Array.isArray(db.users) ? new Map(db.users.map(u => [u.id, u])) : new Map();
      const members = (db.groupMembers || [])
        .filter(m => m.groupId === group.id)
        .map(m => ({
          ...m,
          athleteName: usersMap.get(m.athleteId)?.name || 'Atleta',
        }));

      json(res, 200, { group, members });
    },

    'PUT /api/coach/groups/{groupId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const group = (db.coachGroups || []).find(g => g.id === req.groupId);
      if (!group) return b2bError(res, 404, 'group_not_found', 'group not found');
      if (group.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');

      const body = await readBody(req);
      const updated = { ...group };

      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) {
          return b2bError(res, 400, 'invalid_name', 'name must be between 1 and 100 characters');
        }
        updated.name = name;
      }

      if (body.description !== undefined) {
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (description.length > 1000) {
          return b2bError(res, 400, 'invalid_description', 'description must be under 1000 characters');
        }
        updated.description = description;
      }

      if (body.category !== undefined) {
        const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'geral';
        if (category.length > 50) {
          return b2bError(res, 400, 'invalid_category', 'category must be under 50 characters');
        }
        updated.category = category;
      }

      if (body.maxMembers !== undefined) {
        if (!Number.isInteger(body.maxMembers) || body.maxMembers < 1 || body.maxMembers > (limits.maxMembersPerGroup ?? 500)) {
          return b2bError(res, 400, 'invalid_max_members', `maxMembers must be between 1 and ${limits.maxMembersPerGroup ?? 500}`);
        }
        if (body.maxMembers < group.memberCount) {
          return b2bError(res, 409, 'max_members_below_current', 'maxMembers cannot be less than current active members');
        }
        updated.maxMembers = body.maxMembers;
      }

      if (body.isPrivate !== undefined) {
        updated.isPrivate = Boolean(body.isPrivate);
      }

      if (body.archived !== undefined) {
        updated.archivedAt = body.archived ? (group.archivedAt || new Date(now()).toISOString()) : null;
      }

      updated.updatedAt = new Date(now()).toISOString();

      const candidate = structuredClone(db);
      candidate.coachGroups = candidate.coachGroups.map(g => g.id === group.id ? updated : g);

      try {
        await commit(candidate);
        audit?.(req, 'coach.group.update', { user: coach, groupId: group.id });
        json(res, 200, { group: updated });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'DELETE /api/coach/groups/{groupId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const group = (db.coachGroups || []).find(g => g.id === req.groupId);
      if (!group) return b2bError(res, 404, 'group_not_found', 'group not found');
      if (group.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');

      const candidate = structuredClone(db);
      candidate.coachGroups = candidate.coachGroups.filter(g => g.id !== group.id);
      candidate.groupMembers = (candidate.groupMembers || []).filter(m => m.groupId !== group.id);

      // Unlink or delete group challenges
      const groupChallengeIds = new Set((candidate.challenges || []).filter(c => c.groupId === group.id).map(c => c.id));
      candidate.challenges = (candidate.challenges || []).filter(c => c.groupId !== group.id);
      candidate.challengeScores = (candidate.challengeScores || []).filter(s => !groupChallengeIds.has(s.challengeId));
      candidate.challengeActivityFeed = (candidate.challengeActivityFeed || []).filter(f => !groupChallengeIds.has(f.challengeId));

      try {
        await commit(candidate);
        audit?.(req, 'coach.group.delete', { user: coach, groupId: group.id });
        json(res, 200, { ok: true, id: group.id });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'POST /api/coach/groups/{groupId}/members': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const group = (db.coachGroups || []).find(g => g.id === req.groupId);
      if (!group) return b2bError(res, 404, 'group_not_found', 'group not found');
      if (group.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');
      if (group.archivedAt) return b2bError(res, 409, 'group_archived', 'cannot add members to an archived group');

      const body = await readBody(req);
      const athleteId = typeof body.athleteId === 'string' ? body.athleteId : '';
      if (!athleteId || !ID_RE.test(athleteId)) {
        return b2bError(res, 400, 'invalid_athlete_id', 'valid athleteId is required');
      }

      const targetUser = (db.users || []).find(u => u.id === athleteId);
      if (!targetUser) return b2bError(res, 404, 'athlete_not_found', 'athlete not found');
      if (profileOf(targetUser).kind === 'coach') {
        return b2bError(res, 400, 'invalid_athlete', 'coaches cannot be added as group members');
      }

      const role = body.role !== undefined ? body.role : 'member';
      if (!MEMBER_ROLES.has(role)) {
        return b2bError(res, 400, 'invalid_role', 'role must be member or moderator');
      }

      if (group.memberCount >= group.maxMembers) {
        return b2bError(res, 409, 'group_full', 'group has reached maximum capacity');
      }

      const existingMember = (db.groupMembers || []).find(m => m.groupId === group.id && m.athleteId === athleteId);
      if (existingMember && existingMember.status === 'active') {
        return b2bError(res, 409, 'already_member', 'athlete is already an active member of this group');
      }

      const nowIso = new Date(now()).toISOString();
      const candidate = structuredClone(db);
      candidate.groupMembers ||= [];

      let memberRecord;
      if (existingMember) {
        memberRecord = {
          ...existingMember,
          status: 'active',
          role,
          joinedAt: nowIso,
        };
        candidate.groupMembers = candidate.groupMembers.map(m => m.id === existingMember.id ? memberRecord : m);
      } else {
        memberRecord = {
          id: genId('gmem', candidate.groupMembers),
          groupId: group.id,
          coachId: coach.id,
          athleteId,
          joinedAt: nowIso,
          role,
          status: 'active',
        };
        candidate.groupMembers.push(memberRecord);
      }

      const updatedGroup = candidate.coachGroups.find(g => g.id === group.id);
      updatedGroup.memberCount = candidate.groupMembers.filter(m => m.groupId === group.id && m.status === 'active').length;
      updatedGroup.updatedAt = nowIso;

      try {
        await commit(candidate);
        audit?.(req, 'coach.group.member.add', { user: coach, groupId: group.id, athleteId });
        json(res, 201, { member: memberRecord });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'DELETE /api/coach/groups/{groupId}/members/{athleteId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const group = (db.coachGroups || []).find(g => g.id === req.groupId);
      if (!group) return b2bError(res, 404, 'group_not_found', 'group not found');
      if (group.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');

      const member = (db.groupMembers || []).find(m => m.groupId === group.id && m.athleteId === req.athleteId && m.status === 'active');
      if (!member) return b2bError(res, 404, 'member_not_found', 'active member not found in group');

      const nowIso = new Date(now()).toISOString();
      const candidate = structuredClone(db);
      candidate.groupMembers = candidate.groupMembers.map(m =>
        m.id === member.id ? { ...m, status: 'removed' } : m
      );

      const updatedGroup = candidate.coachGroups.find(g => g.id === group.id);
      updatedGroup.memberCount = candidate.groupMembers.filter(m => m.groupId === group.id && m.status === 'active').length;
      updatedGroup.updatedAt = nowIso;

      try {
        await commit(candidate);
        audit?.(req, 'coach.group.member.remove', { user: coach, groupId: group.id, athleteId: req.athleteId });
        json(res, 200, { ok: true, athleteId: req.athleteId, status: 'removed' });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    // -------------------------------------------------------------
    // Coach Challenge Routes
    // -------------------------------------------------------------

    'POST /api/coach/challenges': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const body = await readBody(req);

      const title = (body.name || body.title || '').trim();
      if (!title || title.length > 100) {
        return b2bError(res, 400, 'invalid_title', 'challenge name/title is required and must be under 100 characters');
      }

      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (description.length > 2000) {
        return b2bError(res, 400, 'invalid_description', 'description must be under 2000 characters');
      }

      if (!CHALLENGE_TYPES.has(body.type)) {
        return b2bError(res, 400, 'invalid_type', 'type must be workouts_count, habits_consistency, volume_load, or custom_points');
      }

      if (!CHALLENGE_SCOPES.has(body.scope)) {
        return b2bError(res, 400, 'invalid_scope', 'scope must be group or coach_students');
      }

      let groupId = null;
      if (body.scope === 'group') {
        groupId = typeof body.groupId === 'string' ? body.groupId : null;
        if (!groupId) return b2bError(res, 400, 'missing_group_id', 'groupId is required when scope is group');
        const grp = (db.coachGroups || []).find(g => g.id === groupId);
        if (!grp) return b2bError(res, 404, 'group_not_found', 'specified group does not exist');
        if (grp.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'group does not belong to you');
      }

      const startMs = Date.parse(body.startAt);
      const endMs = Date.parse(body.endAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return b2bError(res, 400, 'invalid_dates', 'startAt and endAt must be valid ISO date strings');
      }
      if (endMs <= startMs) {
        return b2bError(res, 400, 'invalid_dates', 'endAt must be after startAt');
      }

      const timeZone = typeof body.timeZone === 'string' && validTimeZone(body.timeZone) ? body.timeZone : 'UTC';
      const status = CHALLENGE_STATUSES.has(body.status) ? body.status : 'active';
      const rules = record(body.rules) ? body.rules : {};

      const coachChallengeCount = (db.challenges || []).filter(c => c.coachId === coach.id && c.status !== 'archived').length;
      if (coachChallengeCount >= (limits.maxChallengesPerCoach ?? 100)) {
        return b2bError(res, 409, 'challenge_limit_reached', 'maximum number of challenges reached for this coach');
      }

      const nowIso = new Date(now()).toISOString();
      const challenge = {
        id: genId('chal', db.challenges),
        coachId: coach.id,
        groupId,
        scope: body.scope,
        name: title,
        title,
        description,
        type: body.type,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        timeZone,
        status,
        rules,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const candidate = structuredClone(db);
      candidate.challenges ||= [];
      candidate.challenges.push(challenge);

      try {
        await commit(candidate);
        audit?.(req, 'coach.challenge.create', { user: coach, challengeId: challenge.id });
        json(res, 201, { challenge });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'GET /api/coach/challenges': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      let challenges = (db.challenges || []).filter(c => c.coachId === coach.id);
      challenges.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      json(res, 200, { challenges });
    },

    'GET /api/coach/challenges/{challengeId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const challenge = (db.challenges || []).find(c => c.id === req.challengeId);
      if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found');
      if (challenge.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'challenge does not belong to this coach');
      json(res, 200, { challenge });
    },

    'PUT /api/coach/challenges/{challengeId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const challenge = (db.challenges || []).find(c => c.id === req.challengeId);
      if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found');
      if (challenge.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');

      const body = await readBody(req);
      const updated = { ...challenge };

      if (body.name !== undefined || body.title !== undefined) {
        const title = (body.name || body.title || '').trim();
        if (!title || title.length > 100) {
          return b2bError(res, 400, 'invalid_title', 'name/title must be between 1 and 100 characters');
        }
        updated.name = title;
        updated.title = title;
      }

      if (body.description !== undefined) {
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (description.length > 2000) {
          return b2bError(res, 400, 'invalid_description', 'description must be under 2000 characters');
        }
        updated.description = description;
      }

      if (body.startAt !== undefined || body.endAt !== undefined) {
        const startMs = Date.parse(body.startAt !== undefined ? body.startAt : challenge.startAt);
        const endMs = Date.parse(body.endAt !== undefined ? body.endAt : challenge.endAt);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          return b2bError(res, 400, 'invalid_dates', 'startAt and endAt must be valid ISO date strings');
        }
        if (endMs <= startMs) {
          return b2bError(res, 400, 'invalid_dates', 'endAt must be after startAt');
        }
        updated.startAt = new Date(startMs).toISOString();
        updated.endAt = new Date(endMs).toISOString();
      }

      if (body.timeZone !== undefined) {
        if (!validTimeZone(body.timeZone)) return b2bError(res, 400, 'invalid_timezone', 'valid timeZone is required');
        updated.timeZone = body.timeZone;
      }

      if (body.status !== undefined) {
        if (!CHALLENGE_STATUSES.has(body.status)) return b2bError(res, 400, 'invalid_status', 'invalid challenge status');
        updated.status = body.status;
      }

      if (body.rules !== undefined) {
        if (!record(body.rules)) return b2bError(res, 400, 'invalid_rules', 'rules must be an object');
        updated.rules = body.rules;
      }

      updated.updatedAt = new Date(now()).toISOString();

      const candidate = structuredClone(db);
      candidate.challenges = candidate.challenges.map(c => c.id === challenge.id ? updated : c);

      try {
        await commit(candidate);
        audit?.(req, 'coach.challenge.update', { user: coach, challengeId: challenge.id });
        json(res, 200, { challenge: updated });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'DELETE /api/coach/challenges/{challengeId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const challenge = (db.challenges || []).find(c => c.id === req.challengeId);
      if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found');
      if (challenge.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');

      const candidate = structuredClone(db);
      candidate.challenges = candidate.challenges.filter(c => c.id !== challenge.id);
      candidate.challengeScores = (candidate.challengeScores || []).filter(s => s.challengeId !== challenge.id);
      candidate.challengeActivityFeed = (candidate.challengeActivityFeed || []).filter(f => f.challengeId !== challenge.id);

      try {
        await commit(candidate);
        audit?.(req, 'coach.challenge.delete', { user: coach, challengeId: challenge.id });
        json(res, 200, { ok: true, id: challenge.id });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'GET /api/coach/challenges/{challengeId}/leaderboard': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const challenge = (db.challenges || []).find(c => c.id === req.challengeId);
      if (!challenge) return b2bError(res, 404, 'challenge_not_found', 'challenge not found');
      if (challenge.coachId !== coach.id) return b2bError(res, 403, 'access_denied', 'access denied');

      const result = calculateChallengeLeaderboard(challenge, { db, readState, nowMs: now() });
      json(res, 200, result);
    },

    // -------------------------------------------------------------
    // Athlete Group Routes
    // -------------------------------------------------------------

    'GET /api/athlete/groups': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const activeMemberships = (db.groupMembers || []).filter(m => m.athleteId === athlete.id && m.status === 'active');
      const membershipMap = new Map(activeMemberships.map(m => [m.groupId, m]));
      const groups = (db.coachGroups || [])
        .filter(g => membershipMap.has(g.id))
        .map(g => ({
          ...g,
          myMembership: membershipMap.get(g.id),
        }));
      json(res, 200, { groups });
    },

    'POST /api/athlete/groups/join': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const body = await readBody(req);
      const code = typeof body.inviteCode === 'string' ? body.inviteCode.trim().toUpperCase() : '';
      if (!code) return b2bError(res, 400, 'missing_invite_code', 'inviteCode is required');

      const group = (db.coachGroups || []).find(g => (g.inviteCode || '').toUpperCase() === code);
      if (!group) return b2bError(res, 404, 'group_not_found', 'invalid invite code');
      if (group.archivedAt) return b2bError(res, 409, 'group_archived', 'cannot join an archived group');

      const existingMember = (db.groupMembers || []).find(m => m.groupId === group.id && m.athleteId === athlete.id);
      if (existingMember && existingMember.status === 'active') {
        return b2bError(res, 409, 'already_member', 'already an active member of this group');
      }

      if (group.memberCount >= group.maxMembers) {
        return b2bError(res, 409, 'group_full', 'group has reached maximum capacity');
      }

      const nowIso = new Date(now()).toISOString();
      const candidate = structuredClone(db);
      candidate.groupMembers ||= [];

      let memberRecord;
      if (existingMember) {
        memberRecord = { ...existingMember, status: 'active', joinedAt: nowIso };
        candidate.groupMembers = candidate.groupMembers.map(m => m.id === existingMember.id ? memberRecord : m);
      } else {
        memberRecord = {
          id: genId('gmem', candidate.groupMembers),
          groupId: group.id,
          coachId: group.coachId,
          athleteId: athlete.id,
          joinedAt: nowIso,
          role: 'member',
          status: 'active',
        };
        candidate.groupMembers.push(memberRecord);
      }

      const updatedGroup = candidate.coachGroups.find(g => g.id === group.id);
      updatedGroup.memberCount = candidate.groupMembers.filter(m => m.groupId === group.id && m.status === 'active').length;
      updatedGroup.updatedAt = nowIso;

      try {
        await commit(candidate);
        audit?.(req, 'athlete.group.join', { user: athlete, groupId: group.id });
        json(res, 200, { ok: true, group: updatedGroup, member: memberRecord });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    'POST /api/athlete/groups/{groupId}/leave': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const member = (db.groupMembers || []).find(m => m.groupId === req.groupId && m.athleteId === athlete.id && m.status === 'active');
      if (!member) return b2bError(res, 404, 'not_member', 'you are not an active member of this group');

      const nowIso = new Date(now()).toISOString();
      const candidate = structuredClone(db);
      candidate.groupMembers = candidate.groupMembers.map(m =>
        m.id === member.id ? { ...m, status: 'left' } : m
      );

      const group = candidate.coachGroups.find(g => g.id === req.groupId);
      if (group) {
        group.memberCount = candidate.groupMembers.filter(m => m.groupId === group.id && m.status === 'active').length;
        group.updatedAt = nowIso;
      }

      try {
        await commit(candidate);
        audit?.(req, 'athlete.group.leave', { user: athlete, groupId: req.groupId });
        json(res, 200, { ok: true, groupId: req.groupId, status: 'left' });
      } catch (e) {
        b2bError(res, 503, 'storage_unavailable', e.message);
      }
    },

    // -------------------------------------------------------------
    // Athlete Challenge Routes
    // -------------------------------------------------------------

    'GET /api/athlete/challenges': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const myGroupIds = new Set((db.groupMembers || []).filter(m => m.athleteId === athlete.id && m.status === 'active').map(m => m.groupId));
      const myCoachIds = new Set((db.coachAthleteLinks || []).filter(l => l.athleteId === athlete.id && l.status === 'active').map(l => l.coachId));

      const challenges = (db.challenges || [])
        .filter(c => {
          if (c.status === 'archived' || c.status === 'draft') return false;
          if (c.scope === 'group') return myGroupIds.has(c.groupId);
          if (c.scope === 'coach_students') return myCoachIds.has(c.coachId);
          return false;
        })
        .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));

      json(res, 200, { challenges });
    },

    'GET /api/athlete/challenges/{challengeId}': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const challenge = (db.challenges || []).find(c => c.id === req.challengeId);
      if (!challenge || challenge.status === 'draft') {
        return b2bError(res, 404, 'challenge_not_found', 'challenge not found');
      }

      let eligible = false;
      if (challenge.scope === 'group') {
        eligible = (db.groupMembers || []).some(m => m.groupId === challenge.groupId && m.athleteId === athlete.id && m.status === 'active');
      } else if (challenge.scope === 'coach_students') {
        eligible = (db.coachAthleteLinks || []).some(l => l.coachId === challenge.coachId && l.athleteId === athlete.id && l.status === 'active');
      }

      if (!eligible) {
        return b2bError(res, 403, 'access_denied', 'you are not an active participant in this challenge');
      }

      json(res, 200, { challenge });
    },

    'GET /api/athlete/challenges/{challengeId}/leaderboard': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const challenge = (db.challenges || []).find(c => c.id === req.challengeId);
      if (!challenge || challenge.status === 'draft') {
        return b2bError(res, 404, 'challenge_not_found', 'challenge not found');
      }

      let eligible = false;
      if (challenge.scope === 'group') {
        eligible = (db.groupMembers || []).some(m => m.groupId === challenge.groupId && m.athleteId === athlete.id && m.status === 'active');
      } else if (challenge.scope === 'coach_students') {
        eligible = (db.coachAthleteLinks || []).some(l => l.coachId === challenge.coachId && l.athleteId === athlete.id && l.status === 'active');
      }

      if (!eligible) {
        return b2bError(res, 403, 'access_denied', 'you are not an active participant in this challenge');
      }

      const result = calculateChallengeLeaderboard(challenge, { db, readState, nowMs: now() });
      json(res, 200, result);
    },
  };
}
