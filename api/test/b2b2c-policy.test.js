import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAthleteAccess } from '../b2b2c.js';

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
