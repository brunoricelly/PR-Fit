import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAthleteAccess, compactB2B2C } from '../b2b2c.js';

const coach = { id: 'u_coach', profile: { kind: 'coach', coachSpecialties: ['training'] } };
const athlete = { id: 'u_athlete' };
const otherCoach = { id: 'u_other', profile: { kind: 'coach', coachSpecialties: ['training'] } };

const dbWith = status => ({
  coachAthleteLinks: [{
    id: 'cal_1', coachId: coach.id, athleteId: athlete.id, scopes: ['training'], status,
  }],
});

test('authorization is scoped to the active coach-athlete link', () => {
  assert.equal(authorizeAthleteAccess(dbWith('active'), coach, athlete.id, 'athlete:training:write').ok, true);
  assert.equal(authorizeAthleteAccess(dbWith('active'), otherCoach, athlete.id, 'athlete:training:write').code, 'relationship_not_found');
  assert.equal(authorizeAthleteAccess(dbWith('active'), coach, athlete.id, 'athlete:nutrition:write').code, 'scope_forbidden');
  assert.equal(authorizeAthleteAccess(dbWith('suspended'), coach, athlete.id, 'athlete:training:write').code, 'relationship_inactive');
  assert.equal(authorizeAthleteAccess(dbWith('ended'), coach, athlete.id, 'athlete:training:write').code, 'relationship_inactive');
  assert.equal(authorizeAthleteAccess(dbWith('active'), athlete, athlete.id, 'athlete:training:write').ok, true);
  assert.equal(authorizeAthleteAccess(dbWith('active'), coach, athlete.id, 'athlete:assessments:read').code, 'scope_forbidden');
});

test('assessment access requires both professional specialty and explicit relationship consent', () => {
  const assessmentCoach = { ...coach, profile: { kind: 'coach', coachSpecialties: ['training', 'assessments'] } };
  const withoutConsent = dbWith('active');
  assert.equal(authorizeAthleteAccess(withoutConsent, assessmentCoach, athlete.id, 'athlete:assessments:read').code, 'scope_forbidden');
  withoutConsent.coachAthleteLinks[0].scopes.push('assessments');
  assert.equal(authorizeAthleteAccess(withoutConsent, assessmentCoach, athlete.id, 'athlete:assessments:read').ok, true);
});

test('authorization uses current specialties and the current live relationship', () => {
  const nutritionCoach = { ...coach, profile: { kind: 'coach', coachSpecialties: ['nutrition'] } };
  assert.equal(authorizeAthleteAccess(dbWith('active'), nutritionCoach, athlete.id, 'athlete:training:write').code, 'scope_forbidden');

  const renewed = dbWith('ended');
  renewed.coachAthleteLinks.push({
    id: 'cal_2', coachId: coach.id, athleteId: athlete.id, scopes: ['training'], status: 'active',
  });
  const access = authorizeAthleteAccess(renewed, coach, athlete.id, 'athlete:training:write');
  assert.equal(access.ok, true);
  assert.equal(access.link.id, 'cal_2');
});

test('a professional may remain an athlete in another scoped relationship', () => {
  const dualRoleAthlete = { id: athlete.id, profile: { kind: 'coach', coachSpecialties: ['nutrition'] } };
  const linked = authorizeAthleteAccess(dbWith('active'), coach, dualRoleAthlete.id, 'athlete:training:read');
  assert.equal(linked.ok, true);

  const unrelated = authorizeAthleteAccess(dbWith('active'), dualRoleAthlete, 'u_someone_else', 'athlete:nutrition:read');
  assert.equal(unrelated.code, 'relationship_not_found');

  const ended = authorizeAthleteAccess(dbWith('ended'), coach, dualRoleAthlete.id, 'athlete:training:read');
  assert.equal(ended.code, 'relationship_inactive');
});

test('assessment retention removes expired sensitive records', () => {
  const db = {
    coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [],
    coachAssessments: [
      { id: 'cas_old', coachId: coach.id, athleteId: athlete.id, assessedAt: '2020-01-01T00:00:00.000Z' },
      { id: 'cas_live', coachId: coach.id, athleteId: athlete.id, assessedAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const result = compactB2B2C(db, {
    maxInvites: 10, maxLinks: 10, maxPrescriptions: 10, terminalInvitesKeep: 0, terminalLinksKeep: 0,
    terminalPrescriptionsKeep: 0, terminalRetentionDays: 0, assessmentRetentionDays: 365,
    maxAssessments: 10, maxAssessmentsPerAthlete: 10,
  }, Date.parse('2026-06-01T00:00:00.000Z'));
  assert.equal(result.changed, true);
  assert.deepEqual(db.coachAssessments.map(item => item.id), ['cas_live']);
});
