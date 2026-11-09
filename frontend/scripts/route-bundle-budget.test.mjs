import { describe, expect, it } from 'vitest'
import { BASELINE, BUDGET, assertBundleBudget, budgetFailures } from './route-bundle-budget.mjs'

describe('route bundle budget', () => {
  it('requires a real shell reduction from the recorded baseline', () => {
    expect(BUDGET.initialRaw).toBeLessThan(BASELINE.initialRaw)
    expect(BUDGET.initialGzip).toBeLessThan(BASELINE.initialGzip)
    expect(BUDGET.initialAssets).toBeLessThanOrEqual(BASELINE.initialAssets)
    expect(BUDGET.largestRaw).toBeLessThan(BASELINE.largestRaw * 1.011)
    expect(BUDGET.largestGzip).toBeLessThan(BASELINE.largestGzip * 1.011)
    expect(BUDGET.jsChunks).toBeLessThanOrEqual(Math.ceil(BASELINE.jsChunks * 1.1))
  })

  it('accepts a candidate inside every limit', () => {
    const metrics = {
      initialRaw: BUDGET.initialRaw,
      initialGzip: BUDGET.initialGzip,
      initialAssets: BUDGET.initialAssets,
      largestRaw: BUDGET.largestRaw,
      largestGzip: BUDGET.largestGzip,
      jsChunks: BUDGET.jsChunks,
    }
    expect(() => assertBundleBudget(metrics)).not.toThrow()
    expect(budgetFailures(metrics)).toEqual([])
  })

  it('fails deterministically for shell, chunk or request regressions', () => {
    const metrics = {
      initialRaw: BUDGET.initialRaw + 1,
      initialGzip: BUDGET.initialGzip + 1,
      initialAssets: BUDGET.initialAssets + 1,
      largestRaw: BUDGET.largestRaw + 1,
      largestGzip: BUDGET.largestGzip + 1,
      jsChunks: BUDGET.jsChunks + 1,
    }
    expect(() => assertBundleBudget(metrics)).toThrow(/shell inicial bruto/)
    expect(budgetFailures(metrics)).toHaveLength(6)
  })
})
