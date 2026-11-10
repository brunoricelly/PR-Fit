import { describe, it, expect } from 'vitest'
import {
  calculateBmi,
  calculateWhr,
  formatEvolutionNumber,
  formatEvolutionDate,
  buildEvolutionReportData,
  CIRCUMFERENCE_KEYS,
  CIRCUMFERENCE_LABELS_PT,
} from './evolution-report-data.js'

describe('Evolution Report Data & Metrics', () => {
  describe('calculateBmi', () => {
    it('returns null for invalid or missing inputs', () => {
      expect(calculateBmi(null, 175)).toBeNull()
      expect(calculateBmi(70, null)).toBeNull()
      expect(calculateBmi(0, 175)).toBeNull()
      expect(calculateBmi(-10, 175)).toBeNull()
      expect(calculateBmi(70, 0)).toBeNull()
    })

    it('calculates BMI with height in cm and classifies correctly', () => {
      // 50kg, 175cm -> 50 / (1.75^2) = 16.33 -> Abaixo do peso
      const under = calculateBmi(50, 175)
      expect(under.value).toBe(16.3)
      expect(under.classification).toBe('Abaixo do peso')

      // 70kg, 175cm -> 70 / (1.75^2) = 22.86 -> Peso normal (Eutrofia)
      const normal = calculateBmi(70, 175)
      expect(normal.value).toBe(22.9)
      expect(normal.classification).toBe('Peso normal (Eutrofia)')

      // 85kg, 175cm -> 85 / (1.75^2) = 27.76 -> Sobrepeso
      const overweight = calculateBmi(85, 175)
      expect(overweight.value).toBe(27.8)
      expect(overweight.classification).toBe('Sobrepeso')

      // 95kg, 175cm -> 95 / (1.75^2) = 31.02 -> Obesidade Grau I
      const obese1 = calculateBmi(95, 175)
      expect(obese1.value).toBe(31)
      expect(obese1.classification).toBe('Obesidade Grau I')

      // 115kg, 175cm -> 115 / (1.75^2) = 37.55 -> Obesidade Grau II
      const obese2 = calculateBmi(115, 175)
      expect(obese2.value).toBe(37.6)
      expect(obese2.classification).toBe('Obesidade Grau II')

      // 130kg, 175cm -> 130 / (1.75^2) = 42.45 -> Obesidade Grau III (Mórbida)
      const obese3 = calculateBmi(130, 175)
      expect(obese3.value).toBe(42.4)
      expect(obese3.classification).toBe('Obesidade Grau III (Mórbida)')
    })

    it('handles height specified in meters (e.g. 1.75)', () => {
      const res = calculateBmi(70, 1.75)
      expect(res.value).toBe(22.9)
      expect(res.classification).toBe('Peso normal (Eutrofia)')
    })
  })

  describe('calculateWhr (RCQ)', () => {
    it('returns null for missing or invalid waist/hip values', () => {
      expect(calculateWhr(null, 100)).toBeNull()
      expect(calculateWhr(80, null)).toBeNull()
      expect(calculateWhr(0, 100)).toBeNull()
      expect(calculateWhr(80, 0)).toBeNull()
    })

    it('classifies cardiovascular risk for males', () => {
      // waist 80, hip 100 -> 0.80 -> Baixo risco
      const low = calculateWhr(80, 100, 'male')
      expect(low.value).toBe(0.8)
      expect(low.classification).toBe('Baixo risco cardiovascular')

      // waist 92, hip 100 -> 0.92 -> Risco moderado (0.90 to 0.95)
      const mod = calculateWhr(92, 100, 'male')
      expect(mod.value).toBe(0.92)
      expect(mod.classification).toBe('Risco cardiovascular moderado')

      // waist 102, hip 100 -> 1.02 -> Alto risco
      const high = calculateWhr(102, 100, 'male')
      expect(high.value).toBe(1.02)
      expect(high.classification).toBe('Alto risco cardiovascular')
    })

    it('classifies cardiovascular risk for females', () => {
      // waist 70, hip 100 -> 0.70 -> Baixo risco (< 0.80)
      const low = calculateWhr(70, 100, 'female')
      expect(low.value).toBe(0.7)
      expect(low.classification).toBe('Baixo risco cardiovascular')

      // waist 82, hip 100 -> 0.82 -> Risco moderado (0.80 to 0.85)
      const mod = calculateWhr(82, 100, 'female')
      expect(mod.value).toBe(0.82)
      expect(mod.classification).toBe('Risco cardiovascular moderado')

      // waist 89, hip 100 -> 0.89 -> Alto risco (> 0.85)
      const high = calculateWhr(89, 100, 'female')
      expect(high.value).toBe(0.89)
      expect(high.classification).toBe('Alto risco cardiovascular')
    })
  })

  describe('formatEvolutionNumber and formatEvolutionDate', () => {
    it('formats numbers for Brazilian Portuguese locale', () => {
      expect(formatEvolutionNumber(null)).toBe('–')
      expect(formatEvolutionNumber('abc')).toBe('–')
      expect(formatEvolutionNumber(78.5)).toBe('78,5')
      expect(formatEvolutionNumber(1200.75)).toBe('1.200,75')
    })

    it('formats ISO dates in pt-BR format', () => {
      expect(formatEvolutionDate(null)).toBe('')
      expect(formatEvolutionDate('2026-11-10')).toBe('10/11/2026')
    })
  })

  describe('buildEvolutionReportData', () => {
    it('compiles report with complete assessments, photos, and coach/athlete details', () => {
      const assessments = [
        {
          id: 'as_1',
          assessedAt: '2026-08-01T10:00:00Z',
          weightKg: 85,
          heightCm: 180,
          results: { bodyFatPercent: 22, leanMassKg: 66.3, protocol: 'pollock3' },
          circumferences: { chest: 104, waist: 92, hip: 102, arm: 35, thigh: 60, calf: 38, neck: 40 },
          photos: [{ url: '/photos/as_1_front.jpg', label: 'Frente' }],
        },
        {
          id: 'as_2',
          assessedAt: '2026-11-01T10:00:00Z',
          weightKg: 80,
          heightCm: 180,
          results: { bodyFatPercent: 17, leanMassKg: 66.4, protocol: 'pollock3' },
          circumferences: { chest: 102, waist: 84, hip: 99, arm: 36, thigh: 58, calf: 38, neck: 39 },
          photos: [{ url: '/photos/as_2_front.jpg', label: 'Frente' }],
        },
      ]

      const report = {
        id: 'prep_test_1',
        interval: { from: '2026-08-01', to: '2026-11-01' },
        summary: 'Ótima evolução com redução de 5kg e 5% de gordura.',
        snapshot: {
          generatedAt: '2026-11-02T15:00:00Z',
          metrics: {
            workouts_per_week: { currentValue: 4.2 },
            nutrition_adherence_percent: { currentValue: 88 },
            habit_adherence_percent: { currentValue: 92 },
          },
        },
      }

      const athlete = { name: 'João Silva', email: 'joao@example.com' }
      const coach = { name: 'Treinador Carlos', cref: 'CREF 123456-G/SP' }

      const data = buildEvolutionReportData({
        report,
        assessments,
        athlete,
        coach,
        isCoach: true,
      })

      expect(data.athlete.name).toBe('João Silva')
      expect(data.coach.name).toBe('Treinador Carlos')
      expect(data.coach.cref).toBe('CREF 123456-G/SP')
      expect(data.period.from).toBe('2026-08-01')
      expect(data.period.to).toBe('2026-11-01')

      // Body metrics
      expect(data.metrics.weight.current).toBe(80)
      expect(data.metrics.weight.initial).toBe(85)
      expect(data.metrics.weight.delta).toBe(-5)

      expect(data.metrics.bodyFat.current).toBe(17)
      expect(data.metrics.bodyFat.initial).toBe(22)
      expect(data.metrics.bodyFat.delta).toBe(-5)

      expect(data.metrics.leanMass.current).toBe(66.4)
      expect(data.metrics.leanMass.initial).toBe(66.3)
      expect(data.metrics.leanMass.delta).toBe(0.1)

      // BMI (80 / 1.80^2 = 24.69 -> 24.7 Peso normal)
      expect(data.metrics.bmi.value).toBe(24.7)
      expect(data.metrics.bmi.classification).toBe('Peso normal (Eutrofia)')

      // WHR (84 / 99 = 0.85 -> Baixo risco)
      expect(data.metrics.whr.value).toBe(0.85)
      expect(data.metrics.whr.classification).toBe('Baixo risco cardiovascular')

      // Perimetry
      expect(data.perimetry.history.length).toBe(2)
      expect(data.perimetry.totalDeltas.waist).toBe(-8)
      expect(data.perimetry.totalDeltas.chest).toBe(-2)
      expect(data.perimetry.totalDeltas.arm).toBe(1)

      // Photos
      expect(data.photos.hasPhotos).toBe(true)
      expect(data.photos.before.url).toBe('/photos/as_1_front.jpg')
      expect(data.photos.after.url).toBe('/photos/as_2_front.jpg')

      // Adherence
      expect(data.adherence.workoutsPerWeek).toBe(4.2)
      expect(data.adherence.nutritionAdherence).toBe(88)
      expect(data.adherence.habitAdherence).toBe(92)
    })

    it('falls back gracefully when minimal data is supplied', () => {
      const data = buildEvolutionReportData({})
      expect(data.athlete.name).toBe('Aluno')
      expect(data.coach.name).toBe('Treinador Responsável')
      expect(data.metrics.weight.current).toBeUndefined()
      expect(data.metrics.bmi).toBeNull()
      expect(data.metrics.whr).toBeNull()
      expect(data.perimetry.history).toEqual([])
      expect(data.photos.hasPhotos).toBe(false)
      expect(data.disclaimer).toContain('Aviso de saúde')
    })
  })
})
