const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
};

const positive = (value, label) => {
  const number = finite(value, label);
  if (number <= 0) throw new RangeError(`${label} must be greater than zero`);
  return number;
};

function skinfoldSum(value, sites) {
  if (typeof value === 'number') return positive(value, 'skinfold sum');
  if (Array.isArray(value)) {
    if (value.length !== sites.length) throw new RangeError(`expected ${sites.length} skinfolds`);
    return value.reduce((sum, measurement, index) => sum + positive(measurement, sites[index]), 0);
  }
  if (!value || typeof value !== 'object') throw new TypeError('skinfolds must be a sum, array, or object');
  return sites.reduce((sum, site) => sum + positive(value[site], site), 0);
}

function validAge(age) {
  const value = finite(age, 'age');
  if (value < 1 || value > 120) throw new RangeError('age must be from 1 to 120');
  return value;
}

function pollock3Men(skinfolds, age) {
  const sum = skinfoldSum(skinfolds, ['chest', 'abdomen', 'thigh']);
  return 1.10938 - (0.0008267 * sum) + (0.0000016 * sum ** 2) - (0.0002574 * validAge(age));
}

function pollock3Women(skinfolds, age) {
  const sum = skinfoldSum(skinfolds, ['triceps', 'suprailiac', 'thigh']);
  return 1.0994921 - (0.0009929 * sum) + (0.0000023 * sum ** 2) - (0.0001392 * validAge(age));
}

function pollock7Men(skinfolds, age) {
  const sum = skinfoldSum(skinfolds, ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh']);
  return 1.112 - (0.00043499 * sum) + (0.00000055 * sum ** 2) - (0.00028826 * validAge(age));
}

function pollock7Women(skinfolds, age) {
  const sum = skinfoldSum(skinfolds, ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh']);
  return 1.097 - (0.00046971 * sum) + (0.00000056 * sum ** 2) - (0.00012828 * validAge(age));
}

function faulkner4(skinfolds) {
  const sum = skinfoldSum(skinfolds, ['triceps', 'subscapular', 'suprailiac', 'abdomen']);
  return (0.153 * sum) + 5.783;
}

function siri(density) {
  return ((4.95 / positive(density, 'density')) - 4.5) * 100;
}

function fatMass(weightKg, bodyFatPercent) {
  const weight = positive(weightKg, 'weightKg');
  const percentage = finite(bodyFatPercent, 'bodyFatPercent');
  if (percentage < 0 || percentage > 100) throw new RangeError('bodyFatPercent must be from 0 to 100');
  return weight * percentage / 100;
}

function leanMass(weightKg, bodyFatPercent) {
  return positive(weightKg, 'weightKg') - fatMass(weightKg, bodyFatPercent);
}

function bodyComposition(weightKg, bodyFatPercent) {
  return {
    fatMassKg: fatMass(weightKg, bodyFatPercent),
    leanMassKg: leanMass(weightKg, bodyFatPercent),
  };
}

// Keep the requested CommonJS-shaped public surface while remaining loadable in this package,
// whose package.json deliberately sets `type: module` for every API source file.
const module = { exports: {} };
module.exports = {
  pollock3Men,
  pollock3Women,
  pollock3Male: pollock3Men,
  pollock3Female: pollock3Women,
  pollock7Men,
  pollock7Women,
  pollock7Male: pollock7Men,
  pollock7Female: pollock7Women,
  faulkner4,
  siri,
  siriFormula: siri,
  fatMass,
  leanMass,
  bodyComposition,
  calculateBodyComposition: bodyComposition,
};

export {
  pollock3Men, pollock3Women, pollock7Men, pollock7Women, faulkner4,
  siri, fatMass, leanMass, bodyComposition,
  pollock3Men as pollock3Male, pollock3Women as pollock3Female,
  pollock7Men as pollock7Male, pollock7Women as pollock7Female,
  siri as siriFormula, bodyComposition as calculateBodyComposition,
};
export default module.exports;
