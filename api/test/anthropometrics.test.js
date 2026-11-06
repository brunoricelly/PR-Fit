import { test } from 'node:test';
import assert from 'node:assert/strict';
import anthropometrics, {
  pollock3Men, pollock3Women, pollock7Men, pollock7Women,
  faulkner4, siri, fatMass, leanMass, bodyComposition,
} from '../anthropometrics.js';

const closeTo = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

test('Pollock three-fold equations calculate male and female body density', () => {
  const maleSum = 12 + 18 + 16;
  const femaleSum = 14 + 17 + 19;
  closeTo(
    pollock3Men({ chest: 12, abdomen: 18, thigh: 16 }, 32),
    1.10938 - (0.0008267 * maleSum) + (0.0000016 * maleSum ** 2) - (0.0002574 * 32),
  );
  closeTo(
    pollock3Women({ triceps: 14, suprailiac: 17, thigh: 19 }, 29),
    1.0994921 - (0.0009929 * femaleSum) + (0.0000023 * femaleSum ** 2) - (0.0001392 * 29),
  );
});

test('Pollock seven-fold equations calculate male and female body density', () => {
  const folds = { chest: 10, midaxillary: 11, triceps: 12, subscapular: 13, abdomen: 14, suprailiac: 15, thigh: 16 };
  const sum = Object.values(folds).reduce((total, value) => total + value, 0);
  closeTo(pollock7Men(folds, 35), 1.112 - (0.00043499 * sum) + (0.00000055 * sum ** 2) - (0.00028826 * 35));
  closeTo(pollock7Women(folds, 35), 1.097 - (0.00046971 * sum) + (0.00000056 * sum ** 2) - (0.00012828 * 35));
});

test('Faulkner, Siri, fat mass and lean mass calculations are consistent', () => {
  const faulkner = faulkner4({ triceps: 10, subscapular: 12, suprailiac: 14, abdomen: 16 });
  closeTo(faulkner, (52 * 0.153) + 5.783);
  closeTo(siri(1.05), ((4.95 / 1.05) - 4.5) * 100);
  closeTo(fatMass(80, 20), 16);
  closeTo(leanMass(80, 20), 64);
  assert.deepEqual(bodyComposition(80, 20), { fatMassKg: 16, leanMassKg: 64 });
  assert.equal(anthropometrics.pollock3Men, pollock3Men);
});

test('anthropometric calculations reject missing and physiologically invalid inputs', () => {
  assert.throws(() => pollock3Men({ chest: 10, abdomen: 12 }, 30), TypeError);
  assert.throws(() => pollock7Women([1, 2], 30), RangeError);
  assert.throws(() => siri(0), RangeError);
  assert.throws(() => bodyComposition(70, 101), RangeError);
});
