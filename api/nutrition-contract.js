export const LEGACY_NUTRITION_CONTRACT_VERSION = 1;
export const NUTRITION_CONTRACT_VERSION = 2;

export const NUTRITION_TOLERANCES_BY_VERSION = Object.freeze({
  [LEGACY_NUTRITION_CONTRACT_VERSION]: Object.freeze({
    targetMacroCaloriesMin: 0.65,
    targetMacroCaloriesMax: 1.35,
    foodTotalsMin: 0.5,
    foodTotalsMax: 1.5,
    substitutePercent: 0.3,
  }),
  [NUTRITION_CONTRACT_VERSION]: Object.freeze({
    targetMacroCaloriesMin: 0.85,
    targetMacroCaloriesMax: 1.15,
    foodTotalsMin: 0.8,
    foodTotalsMax: 1.2,
    substitutePercent: 0.3,
  }),
});

export const NUTRITION_TOLERANCES = NUTRITION_TOLERANCES_BY_VERSION[NUTRITION_CONTRACT_VERSION];

export function nutritionTolerances(version = NUTRITION_CONTRACT_VERSION) {
  return NUTRITION_TOLERANCES_BY_VERSION[version] || null;
}

export function nutritionTotals(plan) {
  return plan.meals.flatMap(meal => meal.items).reduce((totals, item) => ({
    calories: totals.calories + item.calories,
    protein: totals.protein + item.protein,
    carbs: totals.carbs + item.carbs,
    fats: totals.fats + item.fats,
    fiber: totals.fiber + item.fiber,
  }), { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 });
}

export function nutritionPlanIssues(plan, version = NUTRITION_CONTRACT_VERSION) {
  const tolerances = nutritionTolerances(version);
  if (!tolerances) return [{ field: 'nutritionContractVersion', code: 'unsupported_version', version }];
  const totals = nutritionTotals(plan);
  const targetMacros = plan.targetMacros;
  const macroCalories = targetMacros.protein * 4 + targetMacros.carbs * 4 + targetMacros.fats * 9;
  const issues = [];
  const addRatioIssue = (field, actual, target, min, max, code) => {
    const ratio = target > 0 ? actual / target : actual === 0 ? 1 : Number.POSITIVE_INFINITY;
    if (ratio < min || ratio > max) issues.push({ field, code, actual, target, ratio, min, max });
  };
  addRatioIssue('targetMacros', macroCalories, plan.targetCalories,
    tolerances.targetMacroCaloriesMin, tolerances.targetMacroCaloriesMax, 'macro_calories_out_of_range');
  for (const field of ['calories', 'protein', 'carbs', 'fats', 'fiber']) {
    const target = field === 'calories' ? plan.targetCalories : targetMacros[field];
    if (field === 'fiber' && target === 0) continue;
    addRatioIssue(field, totals[field], target, tolerances.foodTotalsMin, tolerances.foodTotalsMax, 'food_coverage_out_of_range');
  }
  return issues;
}
