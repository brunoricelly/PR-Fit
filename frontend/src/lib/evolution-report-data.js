/**
 * Evolution report data compiler for PR Fit.
 * Consolidates body metrics (weight, body fat, lean mass, BMI, WHR),
 * perimetry history, posture comparison photos, and metadata.
 */

export const CIRCUMFERENCE_KEYS = [
  'chest',
  'waist',
  'hip',
  'arm',
  'thigh',
  'calf',
  'neck',
]

export const CIRCUMFERENCE_LABELS_PT = {
  chest: 'Tórax',
  waist: 'Cintura',
  hip: 'Quadril',
  arm: 'Braço',
  thigh: 'Coxa',
  calf: 'Panturrilha',
  neck: 'Pescoço',
}

export function formatEvolutionNumber(value, maxDigits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '–'
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: maxDigits }).format(Number(value))
}

export function formatEvolutionDate(value, includeTime = false) {
  if (!value) return ''
  try {
    const parsed = new Date(typeof value === 'string' && !value.includes('T') ? `${value}T12:00:00Z` : value)
    if (isNaN(parsed.getTime())) return String(value)
    if (includeTime) {
      return parsed.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    return parsed.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return String(value)
  }
}

/**
 * Calculates BMI (Índice de Massa Corporal / IMC) and WHO standard classification.
 * Formula: weight (kg) / (height (m) ^ 2)
 */
export function calculateBmi(weightKg, heightCm) {
  const w = Number(weightKg)
  const h = Number(heightCm)
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) return null
  const heightM = h > 3 ? h / 100 : h // handles height given in cm vs m
  const bmi = w / (heightM * heightM)
  if (!Number.isFinite(bmi) || bmi <= 0) return null
  const rounded = Math.round(bmi * 10) / 10

  let classification = 'Peso normal (Eutrofia)'
  if (rounded < 18.5) classification = 'Abaixo do peso'
  else if (rounded < 25.0) classification = 'Peso normal (Eutrofia)'
  else if (rounded < 30.0) classification = 'Sobrepeso'
  else if (rounded < 35.0) classification = 'Obesidade Grau I'
  else if (rounded < 40.0) classification = 'Obesidade Grau II'
  else classification = 'Obesidade Grau III (Mórbida)'

  return { value: rounded, classification }
}

/**
 * Calculates Waist-to-Hip Ratio (Relação Cintura-Quadril / RCQ) and cardiovascular risk.
 * Formula: waist (cm) / hip (cm)
 */
export function calculateWhr(waistCm, hipCm, sex = 'male') {
  const waist = Number(waistCm)
  const hip = Number(hipCm)
  if (!Number.isFinite(waist) || waist <= 0 || !Number.isFinite(hip) || hip <= 0) return null
  const ratio = waist / hip
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const rounded = Math.round(ratio * 100) / 100

  const isFemale = String(sex).toLowerCase() === 'female' || String(sex).toLowerCase() === 'f'
  let classification = 'Baixo risco cardiovascular'
  if (isFemale) {
    if (rounded < 0.80) classification = 'Baixo risco cardiovascular'
    else if (rounded <= 0.85) classification = 'Risco cardiovascular moderado'
    else classification = 'Alto risco cardiovascular'
  } else {
    if (rounded < 0.90) classification = 'Baixo risco cardiovascular'
    else if (rounded <= 0.95) classification = 'Risco cardiovascular moderado'
    else classification = 'Alto risco cardiovascular'
  }

  return { value: rounded, classification }
}

/**
 * Compiles a consolidated Evolution Report data payload.
 */
export function buildEvolutionReportData(options = {}) {
  const {
    report = null,
    assessments = [],
    athlete = null,
    coach = null,
    link = null,
    photos = null,
    storeState = null,
    isCoach = false,
  } = options

  // 1. Identification
  const athleteName = athlete?.name
    || report?.athlete?.name
    || link?.athlete?.name
    || (!isCoach ? storeState?.user?.name : null)
    || 'Aluno'

  const athleteEmail = athlete?.email
    || report?.athlete?.email
    || link?.athlete?.email
    || (!isCoach ? storeState?.user?.email : null)
    || ''

  const coachName = coach?.name
    || report?.coach?.name
    || link?.coach?.name
    || (isCoach ? storeState?.user?.name : null)
    || 'Treinador Responsável'

  const coachCref = coach?.cref
    || coach?.profile?.cref
    || link?.coach?.cref
    || link?.coach?.profile?.cref
    || 'CREF Ativo PR Fit'

  // 2. Timeline / Period
  const from = report?.interval?.from
    || report?.snapshot?.period?.from
    || (assessments.length > 1 ? assessments[0]?.assessedAt?.slice(0, 10) : '')
    || ''
  const to = report?.interval?.to
    || report?.snapshot?.period?.to
    || (assessments.length ? assessments[assessments.length - 1]?.assessedAt?.slice(0, 10) : '')
    || new Date().toISOString().slice(0, 10)

  const generatedAt = report?.snapshot?.generatedAt || report?.createdAt || new Date().toISOString()
  const timezone = report?.timezone || 'America/Sao_Paulo'

  // 3. Sorted assessments (chronological)
  const sortedAssessments = Array.isArray(assessments)
    ? assessments.slice().sort((a, b) => Date.parse(a.assessedAt || 0) - Date.parse(b.assessedAt || 0))
    : []

  const initialAssessment = sortedAssessments[0] || null
  const latestAssessment = sortedAssessments[sortedAssessments.length - 1] || null

  // 4. Body metrics
  // Weight
  let currentWeight = latestAssessment?.weightKg
  if (currentWeight == null && report?.snapshot?.metrics?.body_weight?.currentValue != null) {
    currentWeight = report.snapshot.metrics.body_weight.currentValue
  }
  if (currentWeight == null && storeState?.bodyweight?.length) {
    currentWeight = storeState.bodyweight[storeState.bodyweight.length - 1]?.w
  }
  const initialWeight = initialAssessment?.weightKg
    ?? (sortedAssessments.length > 1 ? initialAssessment?.weightKg : null)
    ?? report?.snapshot?.goals?.find(g => g.metric === 'body_weight')?.baselineValue
    ?? null
  const dWeight = currentWeight != null && initialWeight != null
    ? Math.round((Number(currentWeight) - Number(initialWeight)) * 10) / 10
    : null

  // Height (cm)
  const heightCm = latestAssessment?.heightCm || initialAssessment?.heightCm || null

  // Body Fat %
  let currentFat = latestAssessment?.results?.bodyFatPercent ?? latestAssessment?.bioimpedance?.bodyFatPercent
  if (currentFat == null && report?.snapshot?.metrics?.body_fat_percent?.currentValue != null) {
    currentFat = report.snapshot.metrics.body_fat_percent.currentValue
  }
  const initialFat = initialAssessment
    ? (initialAssessment.results?.bodyFatPercent ?? initialAssessment.bioimpedance?.bodyFatPercent)
    : (report?.snapshot?.goals?.find(g => g.metric === 'body_fat_percent')?.baselineValue ?? null)
  const dFat = currentFat != null && initialFat != null
    ? Math.round((Number(currentFat) - Number(initialFat)) * 10) / 10
    : null

  const protocol = latestAssessment?.results?.protocol
    || latestAssessment?.protocol
    || latestAssessment?.skinfolds?.protocol
    || (latestAssessment?.bioimpedance?.bodyFatPercent != null ? 'Bioimpedância' : 'Pollock / Faulkner')

  // Lean Mass (kg)
  let leanMassKg = latestAssessment?.results?.leanMassKg ?? latestAssessment?.bioimpedance?.muscleMassKg
  if (leanMassKg == null && currentWeight != null && currentFat != null) {
    leanMassKg = Math.round(Number(currentWeight) * (1 - (Number(currentFat) / 100)) * 10) / 10
  }
  let initialLeanMass = initialAssessment?.results?.leanMassKg ?? initialAssessment?.bioimpedance?.muscleMassKg
  if (initialLeanMass == null && initialWeight != null && initialFat != null) {
    initialLeanMass = Math.round(Number(initialWeight) * (1 - (Number(initialFat) / 100)) * 10) / 10
  }
  const dLean = leanMassKg != null && initialLeanMass != null
    ? Math.round((Number(leanMassKg) - Number(initialLeanMass)) * 10) / 10
    : null

  // BMI (IMC)
  const bmi = calculateBmi(currentWeight, heightCm)

  // WHR (RCQ)
  const currentWaist = latestAssessment?.circumferences?.waist
  const currentHip = latestAssessment?.circumferences?.hip
  const sex = latestAssessment?.sex || athlete?.sex || 'male'
  const whr = calculateWhr(currentWaist, currentHip, sex)

  // 5. Perimetry / Circumference History
  const perimetryHistory = sortedAssessments.map((item, index) => {
    const prev = sortedAssessments[index - 1]
    const circumferences = item.circumferences || {}
    const deltas = {}
    if (prev?.circumferences) {
      for (const key of CIRCUMFERENCE_KEYS) {
        if (circumferences[key] != null && prev.circumferences[key] != null) {
          deltas[key] = Math.round((Number(circumferences[key]) - Number(prev.circumferences[key])) * 10) / 10
        }
      }
    }
    return {
      id: item.id || `eval_${index}`,
      date: formatEvolutionDate(item.assessedAt),
      isoDate: item.assessedAt,
      weightKg: item.weightKg,
      circumferences,
      deltas,
    }
  })

  // Global perimetry deltas (latest vs first)
  const perimetrySummaryDeltas = {}
  if (sortedAssessments.length > 1) {
    const firstC = initialAssessment?.circumferences || {}
    const lastC = latestAssessment?.circumferences || {}
    for (const key of CIRCUMFERENCE_KEYS) {
      if (lastC[key] != null && firstC[key] != null) {
        perimetrySummaryDeltas[key] = Math.round((Number(lastC[key]) - Number(firstC[key])) * 10) / 10
      }
    }
  }

  // 6. Posture photos comparison
  let beforePhoto = null
  let afterPhoto = null

  if (photos?.before || photos?.after) {
    beforePhoto = photos.before || null
    afterPhoto = photos.after || null
  } else {
    // Extract from assessments
    const assessmentsWithPhotos = sortedAssessments.filter(a => Array.isArray(a.photos) && a.photos.length > 0)
    if (assessmentsWithPhotos.length >= 2) {
      const first = assessmentsWithPhotos[0]
      const last = assessmentsWithPhotos[assessmentsWithPhotos.length - 1]
      beforePhoto = {
        url: first.photos[0].url || first.photos[0].src,
        date: formatEvolutionDate(first.assessedAt),
        label: 'Antes (Avaliação Inicial)',
      }
      afterPhoto = {
        url: last.photos[0].url || last.photos[0].src,
        date: formatEvolutionDate(last.assessedAt),
        label: 'Depois (Avaliação Atual)',
      }
    } else if (assessmentsWithPhotos.length === 1) {
      const single = assessmentsWithPhotos[0]
      if (single.photos.length >= 2) {
        beforePhoto = {
          url: single.photos[0].url || single.photos[0].src,
          date: formatEvolutionDate(single.assessedAt),
          label: 'Antes',
        }
        afterPhoto = {
          url: single.photos[1].url || single.photos[1].src,
          date: formatEvolutionDate(single.assessedAt),
          label: 'Depois',
        }
      } else {
        afterPhoto = {
          url: single.photos[0].url || single.photos[0].src,
          date: formatEvolutionDate(single.assessedAt),
          label: 'Registro Postural',
        }
      }
    }
  }

  const hasPhotos = Boolean(beforePhoto?.url || afterPhoto?.url)

  // 7. Training and adherence summary (from progress report snapshot if available)
  const snapshotMetrics = report?.snapshot?.metrics || {}
  const workoutsPerWeek = snapshotMetrics.workouts_per_week?.currentValue != null
    ? snapshotMetrics.workouts_per_week.currentValue
    : null
  const nutritionAdherence = snapshotMetrics.nutrition_adherence_percent?.currentValue != null
    ? snapshotMetrics.nutrition_adherence_percent.currentValue
    : null
  const habitAdherence = snapshotMetrics.habit_adherence_percent?.currentValue != null
    ? snapshotMetrics.habit_adherence_percent.currentValue
    : null

  // 8. Disclaimer
  const disclaimer = report?.snapshot?.disclaimer
    || 'Aviso de saúde: Este relatório é um documento de acompanhamento de evolução física e corporal desenvolvido para uso conjunto entre o aluno e o profissional de educação física credenciado no PR Fit. As métricas e dados apresentados não constituem diagnóstico médico. Consulte sempre seu médico ou profissional de saúde qualificado antes de iniciar ou alterar sua rotina física ou nutricional.'

  return {
    id: report?.id || `ev_rep_${Date.now()}`,
    athlete: {
      name: athleteName,
      email: athleteEmail,
    },
    coach: {
      name: coachName,
      cref: coachCref,
    },
    period: {
      from,
      to,
      formattedFrom: formatEvolutionDate(from),
      formattedTo: formatEvolutionDate(to),
    },
    generatedAt,
    formattedGeneratedAt: formatEvolutionDate(generatedAt, true),
    timezone,
    metrics: {
      weight: {
        current: currentWeight,
        initial: initialWeight,
        delta: dWeight,
        unit: 'kg',
      },
      bodyFat: {
        current: currentFat,
        initial: initialFat,
        delta: dFat,
        unit: '%',
        protocol,
      },
      leanMass: {
        current: leanMassKg,
        initial: initialLeanMass,
        delta: dLean,
        unit: 'kg',
      },
      bmi,
      whr,
    },
    perimetry: {
      history: perimetryHistory,
      totalDeltas: perimetrySummaryDeltas,
      latestCircumferences: latestAssessment?.circumferences || {},
    },
    photos: {
      before: beforePhoto,
      after: afterPhoto,
      hasPhotos,
    },
    adherence: {
      workoutsPerWeek,
      nutritionAdherence,
      habitAdherence,
    },
    goals: report?.snapshot?.goals || [],
    summaryText: report?.summary || '',
    disclaimer,
  }
}
