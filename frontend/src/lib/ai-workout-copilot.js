import { EXIDX } from './exercises.js'
import PT_BR_NAMES from '../exercise-names/pt-BR.js'

export const OBJECTIVES = [
  {
    id: 'hipertrofia',
    label: 'Hipertrofia',
    subtitle: 'Ganho de massa muscular',
    description: 'Volume moderado a alto com 8 a 12 repetições e intervalos de 60s a 90s.',
  },
  {
    id: 'emagrecimento',
    label: 'Emagrecimento',
    subtitle: 'Definição e queima calórica',
    description: 'Maior densidade metabólica com 12 a 15 repetições e intervalos curtos de 30s a 45s.',
  },
  {
    id: 'forca',
    label: 'Força',
    subtitle: 'Carga submáxima e potência',
    description: 'Cargas altas com 3 a 6 repetições e intervalos completos de 120s a 180s.',
  },
  {
    id: 'condicionamento',
    label: 'Condicionamento',
    subtitle: 'Resistência musculoesquelética',
    description: 'Volume de resistência com 15 a 20 repetições e descanso ativo de 30s a 45s.',
  },
]

export const SPLITS = [
  {
    id: 'ppl',
    label: 'Push / Pull / Legs (ABC)',
    subtitle: 'Empurrar · Puxar · Pernas',
    description: 'Divisão clássica em 3 sessões: peitoral/ombros/tríceps, costas/bíceps e membros inferiores.',
  },
  {
    id: 'upper_lower',
    label: 'Superior / Inferior (AB)',
    subtitle: 'Membros Superiores · Membros Inferiores',
    description: 'Divisão em 2 sessões balanceadas: tronco completo no treino A e pernas/glúteos no treino B.',
  },
  {
    id: 'full_body',
    label: 'Full Body',
    subtitle: 'Corpo Inteiro',
    description: 'Estímulo global equilibrado em todas as sessões para máxima frequência e eficiência.',
  },
]

export const LEVELS = [
  {
    id: 'iniciante',
    label: 'Iniciante',
    subtitle: 'Adaptação e execução segura',
    description: '3 séries por exercício, foco em movimentos consolidados e recuperação adaptativa.',
  },
  {
    id: 'intermediario',
    label: 'Intermediário',
    subtitle: 'Volume equilibrado',
    description: '3 a 4 séries por exercício, equilíbrio entre exercícios compostos e isolamentos guiados.',
  },
  {
    id: 'avancado',
    label: 'Avançado',
    subtitle: 'Alta demanda e intensidade',
    description: '4 séries por exercício, maior sobrecarga e variação angular refinada.',
  },
]

export const RESTRICTIONS = [
  {
    id: 'joelho',
    label: 'Joelho',
    hint: 'Substitui agachamentos profundos e saltos por elevação pélvica, flexora e leg press controlado.',
  },
  {
    id: 'ombro',
    label: 'Ombro',
    hint: 'Substitui desenvolvimentos pesados e pegadas extremas por pegada neutra e apoio torácico.',
  },
  {
    id: 'lombar',
    label: 'Lombar',
    hint: 'Substitui levantamento terra e remadas livres por remadas apoiadas no peito e máquinas.',
  },
]

export const FOCUS_AREAS = [
  { id: 'equilibrado', label: 'Equilibrado' },
  { id: 'gluteos_pernas', label: 'Glúteos & Pernas' },
  { id: 'peitoral_ombros', label: 'Peitoral & Ombros' },
  { id: 'costas_biceps', label: 'Costas & Bíceps' },
]

export function getCleanPtExerciseName(id, fallbackName = '') {
  const customNames = {
    '0025': 'Supino reto com barra',
    '0289': 'Supino reto com halteres',
    '0047': 'Supino inclinado com barra',
    '1030': 'Voador / Peck Deck na máquina',
    '0662': 'Flexão de braços no solo',
    '0169': 'Supino inclinado no cabo',
    '2982': 'Supino no chão com halteres (pegada neutra)',
    '0091': 'Desenvolvimento de ombros com barra sentado',
    '2137': 'Desenvolvimento Arnold com halteres',
    '0334': 'Elevação lateral com halteres',
    '0178': 'Elevação lateral no cabo',
    '11060': 'Face pull no cabo com rotação externa',
    '5607': 'Face pull com pegada neutra',
    '1609': 'Tríceps na polia alta',
    '0306': 'Tríceps testa com halteres',
    '1033': 'Tríceps na máquina',
    '0172': 'Tríceps polia com corda',
    '0027': 'Remada curvada com barra',
    '0150': 'Puxada frontal aberta no cabo',
    '0180': 'Remada baixa sentada no cabo',
    '0652': 'Barra fixa (Pull-up)',
    '1047': 'Puxada frontal pegada fechada/neutra',
    '9698': 'Remada com apoio no peito com halteres',
    '0294': 'Rosca bíceps com halteres',
    '0031': 'Rosca direta com barra',
    '1646': 'Rosca martelo com halteres',
    '1032': 'Rosca bíceps na máquina',
    '1018': 'Encolhimento de ombros',
    '3593': 'Agachamento livre com barra',
    '1027': 'Leg press 45° articulado',
    '5664': 'Cadeira extensora no cabo',
    '9702': 'Agachamento goblet',
    '1060': 'Elevação pélvica com barra (Hip Thrust)',
    '1409': 'Ponte de glúteos no solo',
    '4173': 'Stiff / RDL com barra',
    '3415': 'Mesa / Cadeira flexora',
    '1034': 'Cadeira abdutora na máquina',
    '0417': 'Elevação de panturrilha em pé com halteres',
    '1372': 'Elevação de panturrilha em pé com barra',
    '0472': 'Elevação de pernas na barra',
    '3777': 'Prancha frontal isométrica',
    '4170': 'Prancha de urso isométrica',
    '5265': 'Abdominal supra no solo',
  }

  if (customNames[id]) return customNames[id]

  const translated = PT_BR_NAMES[id]
  if (translated) {
    return translated.charAt(0).toUpperCase() + translated.slice(1)
  }

  const ex = EXIDX[id]
  if (ex?.n) {
    return ex.n.charAt(0).toUpperCase() + ex.n.slice(1)
  }

  return fallbackName || `Exercício #${id}`
}

const EXERCISE_KNOWLEDGE = {
  // Push / Peito
  '0025': { targetMuscle: 'Peitoral', equipment: 'Barra', compound: true, highShoulderStress: true, highLumbarStress: false, highKneeStress: false },
  '0289': { targetMuscle: 'Peitoral', equipment: 'Halteres', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0047': { targetMuscle: 'Peitoral', equipment: 'Barra', compound: true, highShoulderStress: true, highLumbarStress: false, highKneeStress: false },
  '1030': { targetMuscle: 'Peitoral', equipment: 'Máquina', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0662': { targetMuscle: 'Peitoral', equipment: 'Peso corporal', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0169': { targetMuscle: 'Peitoral', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '2982': { targetMuscle: 'Peitoral', equipment: 'Halteres', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Push / Ombros
  '0091': { targetMuscle: 'Ombros', equipment: 'Barra', compound: true, highShoulderStress: true, highLumbarStress: false, highKneeStress: false },
  '2137': { targetMuscle: 'Ombros', equipment: 'Halteres', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0334': { targetMuscle: 'Ombros', equipment: 'Halteres', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0178': { targetMuscle: 'Ombros', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '11060': { targetMuscle: 'Deltoide posterior', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '5607': { targetMuscle: 'Deltoide posterior', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Push / Tríceps
  '1609': { targetMuscle: 'Tríceps', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0306': { targetMuscle: 'Tríceps', equipment: 'Halteres', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '1033': { targetMuscle: 'Tríceps', equipment: 'Máquina', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0172': { targetMuscle: 'Tríceps', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Pull / Costas
  '0027': { targetMuscle: 'Dorsais', equipment: 'Barra', compound: true, highShoulderStress: false, highLumbarStress: true, highKneeStress: false },
  '0150': { targetMuscle: 'Dorsais', equipment: 'Cabo', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0180': { targetMuscle: 'Dorsais', equipment: 'Cabo', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0652': { targetMuscle: 'Dorsais', equipment: 'Peso corporal', compound: true, highShoulderStress: true, highLumbarStress: false, highKneeStress: false },
  '1047': { targetMuscle: 'Dorsais', equipment: 'Cabo', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '9698': { targetMuscle: 'Dorsais', equipment: 'Halteres', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Pull / Bíceps
  '0294': { targetMuscle: 'Bíceps', equipment: 'Halteres', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0031': { targetMuscle: 'Bíceps', equipment: 'Barra', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '1646': { targetMuscle: 'Bíceps', equipment: 'Halteres', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '1032': { targetMuscle: 'Bíceps', equipment: 'Máquina', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Legs / Quadríceps
  '3593': { targetMuscle: 'Quadríceps', equipment: 'Barra', compound: true, highShoulderStress: false, highLumbarStress: true, highKneeStress: true },
  '1027': { targetMuscle: 'Quadríceps', equipment: 'Máquina', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '5664': { targetMuscle: 'Quadríceps', equipment: 'Cabo', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '9702': { targetMuscle: 'Quadríceps', equipment: 'Halteres', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Legs / Glúteos & Isquiotibiais
  '1060': { targetMuscle: 'Glúteos', equipment: 'Barra', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '1409': { targetMuscle: 'Glúteos', equipment: 'Barra', compound: true, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '4173': { targetMuscle: 'Isquiotibiais', equipment: 'Barra', compound: true, highShoulderStress: false, highLumbarStress: true, highKneeStress: false },
  '3415': { targetMuscle: 'Isquiotibiais', equipment: 'Máquina', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '1034': { targetMuscle: 'Glúteos', equipment: 'Máquina', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },

  // Legs / Panturrilhas & Core
  '0417': { targetMuscle: 'Panturrilhas', equipment: 'Halteres', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '1372': { targetMuscle: 'Panturrilhas', equipment: 'Barra', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '0472': { targetMuscle: 'Abdômen', equipment: 'Barra', compound: false, highShoulderStress: true, highLumbarStress: false, highKneeStress: false },
  '3777': { targetMuscle: 'Core', equipment: 'Peso corporal', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '4170': { targetMuscle: 'Core', equipment: 'Peso corporal', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
  '5265': { targetMuscle: 'Abdômen', equipment: 'Peso corporal', compound: false, highShoulderStress: false, highLumbarStress: false, highKneeStress: false },
}

function calculateParameters(objective, level, compound = false) {
  let sets = '3'
  let reps = '8-12'
  let restSeconds = '60'
  let cadenceNote = 'Cadência controlada 2-0-2.'

  if (objective === 'hipertrofia') {
    sets = level === 'avancado' ? '4' : '3'
    reps = compound ? (level === 'avancado' ? '6-10' : '8-10') : '10-12'
    restSeconds = compound ? '90' : '60'
    cadenceNote = 'Foco em tensão mecânica e contração de pico (2-0-2).'
  } else if (objective === 'emagrecimento') {
    sets = level === 'avancado' ? '4' : '3'
    reps = compound ? '10-12' : '12-15'
    restSeconds = compound ? '45' : '30'
    cadenceNote = 'Intervalos curtos para sustentação de frequência cardíaca e demanda metabólica.'
  } else if (objective === 'forca') {
    sets = level === 'iniciante' ? '3' : level === 'avancado' ? '5' : '4'
    reps = compound ? (level === 'avancado' ? '3-5' : '4-6') : '6-8'
    restSeconds = compound ? '150' : '90'
    cadenceNote = 'Recuperação completa entre séries e aceleração concêntrica com técnica sólida.'
  } else if (objective === 'condicionamento') {
    sets = level === 'avancado' ? '4' : '3'
    reps = '15-20'
    restSeconds = '30'
    cadenceNote = 'Ritmo contínuo sem pausas excessivas, mantendo estabilidade postural.'
  }

  return { sets, reps, restSeconds, cadenceNote }
}

function chooseExercise(candidates, restrictions, fallback, seedOffset = 0, usedSet = new Set()) {
  const filtered = candidates.filter(id => {
    const meta = EXERCISE_KNOWLEDGE[id]
    if (!meta) return true
    if (restrictions.includes('joelho') && meta.highKneeStress) return false
    if (restrictions.includes('ombro') && meta.highShoulderStress) return false
    if (restrictions.includes('lombar') && meta.highLumbarStress) return false
    return true
  })

  // Try to find one not already used in this division
  const unused = filtered.filter(id => !usedSet.has(id))
  const pool = unused.length ? unused : (filtered.length ? filtered : [fallback])

  const index = Math.abs(seedOffset) % pool.length
  const chosen = pool[index]
  usedSet.add(chosen)
  return chosen
}

function buildExerciseItem(id, objective, level, restrictions, customCue = '') {
  const meta = EXERCISE_KNOWLEDGE[id] || {
    targetMuscle: 'Geral',
    equipment: 'Aparelho',
    compound: false,
    highShoulderStress: false,
    highLumbarStress: false,
    highKneeStress: false,
  }

  const { sets, reps, restSeconds, cadenceNote } = calculateParameters(objective, level, meta.compound)

  const safetyParts = []
  if (restrictions.includes('joelho') && (meta.targetMuscle === 'Quadríceps' || meta.targetMuscle === 'Glúteos' || meta.targetMuscle === 'Isquiotibiais')) {
    safetyParts.push('Proteção Joelho: amplitude guiada sem estresse patelar excessivo.')
  }
  if (restrictions.includes('ombro') && (meta.targetMuscle === 'Peitoral' || meta.targetMuscle === 'Ombros' || meta.targetMuscle === 'Tríceps' || meta.targetMuscle === 'Deltoide posterior')) {
    safetyParts.push('Proteção Ombro: pegada neutra e escápulas estáveis.')
  }
  if (restrictions.includes('lombar') && (meta.targetMuscle === 'Dorsais' || meta.targetMuscle === 'Quadríceps' || meta.targetMuscle === 'Isquiotibiais')) {
    safetyParts.push('Proteção Lombar: coluna neutra com apoio torácico.')
  }

  const notesList = [cadenceNote, customCue, safetyParts.join(' ')].filter(Boolean)

  return {
    id,
    name: getCleanPtExerciseName(id),
    catalogName: EXIDX[id]?.n || id,
    sets,
    reps,
    load: '',
    restSeconds,
    targetMuscle: meta.targetMuscle,
    equipment: meta.equipment,
    notes: notesList.join(' ').trim(),
    safetyAlert: safetyParts.length ? safetyParts.join(' ') : null,
  }
}

export function generateAiWorkout(options = {}) {
  const {
    objective = 'hipertrofia',
    split = 'ppl',
    level = 'intermediario',
    restrictions = [],
    focus = 'equilibrado',
    seed = 0,
  } = options

  const safeRestrictions = Array.isArray(restrictions) ? restrictions : []
  const seedNum = typeof seed === 'number' ? seed : String(seed).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)

  const divisions = []
  const safetyNotes = []

  if (safeRestrictions.includes('joelho')) {
    safetyNotes.push('Substituições seguras aplicadas para joelho (ênfase em elevação pélvica, flexora e leg press controlado).')
  }
  if (safeRestrictions.includes('ombro')) {
    safetyNotes.push('Substituições seguras aplicadas para ombro (supinos com halteres, pegada neutra e proteção acromial).')
  }
  if (safeRestrictions.includes('lombar')) {
    safetyNotes.push('Substituições seguras aplicadas para lombar (remadas apoiadas no peito, puxadas frontais e estabilização de tronco).')
  }

  if (split === 'ppl') {
    // Treino A - Push
    const usedA = new Set()
    const pushChest1 = chooseExercise(['0025', '0289'], safeRestrictions, '0289', seedNum, usedA)
    const pushChest2 = chooseExercise(['0047', '0289', '1030', '0169'], safeRestrictions, '1030', seedNum + 1, usedA)
    const pushShoulders = chooseExercise(['0091', '2137', '0334'], safeRestrictions, '0334', seedNum + 2, usedA)
    const pushLateral = chooseExercise(['0334', '0178'], safeRestrictions, '0178', seedNum + 3, usedA)
    const pushTriceps1 = chooseExercise(['1609', '0172', '1033'], safeRestrictions, '1609', seedNum + 4, usedA)
    const pushTriceps2 = chooseExercise(['0306', '1033', '1609'], safeRestrictions, '1033', seedNum + 5, usedA)

    const pushExercises = [
      buildExerciseItem(pushChest1, objective, level, safeRestrictions, 'Inicie com ativação escapular completa.'),
      buildExerciseItem(pushChest2, objective, level, safeRestrictions, 'Controle excêntrico na descida.'),
      buildExerciseItem(pushShoulders, objective, level, safeRestrictions, 'Sem hiperextensão lombar no topo.'),
      buildExerciseItem(pushLateral, objective, level, safeRestrictions, 'Cotovelos alinhados à linha dos ombros.'),
      buildExerciseItem(pushTriceps1, objective, level, safeRestrictions, 'Extensão completa no final da fase concêntrica.'),
    ]
    if (level === 'avancado') {
      pushExercises.push(buildExerciseItem(pushTriceps2, objective, level, safeRestrictions, 'Pico de contração de 1 segundo.'))
    }

    // Treino B - Pull
    const usedB = new Set()
    const pullBack1 = chooseExercise(['0027', '9698', '0180'], safeRestrictions, '9698', seedNum, usedB)
    const pullVertical = chooseExercise(['0150', '0652', '1047'], safeRestrictions, '0150', seedNum + 1, usedB)
    const pullBack2 = chooseExercise(['0180', '1047', '9698'], safeRestrictions, '0180', seedNum + 2, usedB)
    const pullRearDelts = chooseExercise(['11060', '5607'], safeRestrictions, '11060', seedNum + 3, usedB)
    const pullBiceps1 = chooseExercise(['0294', '0031'], safeRestrictions, '0294', seedNum + 4, usedB)
    const pullBiceps2 = chooseExercise(['1646', '1032'], safeRestrictions, '1646', seedNum + 5, usedB)

    const pullExercises = [
      buildExerciseItem(pullBack1, objective, level, safeRestrictions, 'Mantenha o peito aberto e feche as escápulas.'),
      buildExerciseItem(pullVertical, objective, level, safeRestrictions, 'Puxe direcionando a barra ou cabo à clavícula.'),
      buildExerciseItem(pullBack2, objective, level, safeRestrictions, 'Apoio firme nos pés e tronco ereto.'),
      buildExerciseItem(pullRearDelts, objective, level, safeRestrictions, 'Foco em saúde do manguito e deltoide posterior.'),
      buildExerciseItem(pullBiceps1, objective, level, safeRestrictions, 'Evite balanço de tronco durante a rosca.'),
    ]
    if (level === 'avancado') {
      pullExercises.push(buildExerciseItem(pullBiceps2, objective, level, safeRestrictions, 'Pegada neutra para foco em braquial.'))
    }

    // Treino C - Legs
    const usedC = new Set()
    const legsQuads = chooseExercise(['3593', '1027', '9702'], safeRestrictions, '1027', seedNum, usedC)
    const legsHamGlute = chooseExercise(['1060', '4173', '1409'], safeRestrictions, '1060', seedNum + 1, usedC)
    const legsCurl = chooseExercise(['3415', '1409'], safeRestrictions, '3415', seedNum + 2, usedC)
    const legsExt = chooseExercise(['5664', '1027', '1034'], safeRestrictions, '5664', seedNum + 3, usedC)
    const legsCalf = chooseExercise(['0417', '1372'], safeRestrictions, '0417', seedNum + 4, usedC)
    const legsCore = chooseExercise(['3777', '4170', '0472', '5265'], safeRestrictions, '3777', seedNum + 5, usedC)

    const legsExercises = [
      buildExerciseItem(legsQuads, objective, level, safeRestrictions, 'Distribua a pressão nos calcanhares e meio do pé.'),
      buildExerciseItem(legsHamGlute, objective, level, safeRestrictions, 'Pausa de 1s na contração máxima de glúteo.'),
      buildExerciseItem(legsCurl, objective, level, safeRestrictions, 'Controle o retorno excêntrico sem soltar o peso.'),
      buildExerciseItem(legsExt, objective, level, safeRestrictions, 'Amplitude sem impacto no ápice da extensão.'),
      buildExerciseItem(legsCalf, objective, level, safeRestrictions, 'Alongamento completo no ponto inferior.'),
    ]
    if (level === 'avancado') {
      legsExercises.push(buildExerciseItem(legsCore, objective, level, safeRestrictions, 'Estabilização profunda de core.'))
    }

    divisions.push(
      {
        name: 'Treino A - Push (Peitoral, Ombros e Tríceps)',
        description: 'Padrão de empurrar horizontal e vertical com preservação articular.',
        exercises: pushExercises,
      },
      {
        name: 'Treino B - Pull (Costas, Trapézio e Bíceps)',
        description: 'Padrão de puxada vertical e horizontal com estímulo de cadeia posterior superior.',
        exercises: pullExercises,
      },
      {
        name: 'Treino C - Legs (Pernas, Glúteos e Core)',
        description: 'Membros inferiores completos com distribuição equilibrada entre quadríceps e cadeia posterior.',
        exercises: legsExercises,
      }
    )
  } else if (split === 'upper_lower') {
    // Treino A - Superior
    const usedA = new Set()
    const upChest = chooseExercise(['0025', '0289'], safeRestrictions, '0289', seedNum, usedA)
    const upRow = chooseExercise(['0027', '9698', '0180'], safeRestrictions, '9698', seedNum + 1, usedA)
    const upPull = chooseExercise(['0150', '1047'], safeRestrictions, '0150', seedNum + 2, usedA)
    const upShoulder = chooseExercise(['0334', '2137', '0178'], safeRestrictions, '0334', seedNum + 3, usedA)
    const upBiceps = chooseExercise(['0294', '1646'], safeRestrictions, '0294', seedNum + 4, usedA)
    const upTriceps = chooseExercise(['1609', '1033'], safeRestrictions, '1609', seedNum + 5, usedA)

    const upperExercises = [
      buildExerciseItem(upChest, objective, level, safeRestrictions, 'Base estável e escápulas fixadas no banco.'),
      buildExerciseItem(upRow, objective, level, safeRestrictions, 'Puxe conduzindo os cotovelos para trás.'),
      buildExerciseItem(upPull, objective, level, safeRestrictions, 'Amplitude completa com ativação de grande dorsal.'),
      buildExerciseItem(upShoulder, objective, level, safeRestrictions, 'Controle lateral estrito sem compensação.'),
      buildExerciseItem(upBiceps, objective, level, safeRestrictions, 'Contração de bíceps com punhos alinhados.'),
    ]
    if (level === 'avancado') {
      upperExercises.push(buildExerciseItem(upTriceps, objective, level, safeRestrictions, 'Tríceps isolado com cotovelos estáveis.'))
    }

    // Treino B - Inferior
    const usedB = new Set()
    const lowQuads = chooseExercise(['3593', '1027', '9702'], safeRestrictions, '1027', seedNum, usedB)
    const lowGlute = chooseExercise(['1060', '1409', '4173'], safeRestrictions, '1060', seedNum + 1, usedB)
    const lowFlex = chooseExercise(['3415', '4173'], safeRestrictions, '3415', seedNum + 2, usedB)
    const lowExt = chooseExercise(['5664', '1034'], safeRestrictions, '5664', seedNum + 3, usedB)
    const lowCalf = chooseExercise(['0417', '1372'], safeRestrictions, '0417', seedNum + 4, usedB)
    const lowCore = chooseExercise(['3777', '4170'], safeRestrictions, '3777', seedNum + 5, usedB)

    const lowerExercises = [
      buildExerciseItem(lowQuads, objective, level, safeRestrictions, 'Profundidade segura com joelhos apontando na linha dos pés.'),
      buildExerciseItem(lowGlute, objective, level, safeRestrictions, 'Extensão de quadril com abdômen contraído.'),
      buildExerciseItem(lowFlex, objective, level, safeRestrictions, 'Tensão contínua nos isquiotibiais.'),
      buildExerciseItem(lowCalf, objective, level, safeRestrictions, 'Cadência com pausa no pico de contração.'),
      buildExerciseItem(lowCore, objective, level, safeRestrictions, 'Manutenção da coluna neutra e respiração contínua.'),
    ]
    if (level === 'avancado') {
      lowerExercises.push(buildExerciseItem(lowExt, objective, level, safeRestrictions, 'Estímulo complementar de extensão de joelhos.'))
    }

    divisions.push(
      {
        name: 'Treino A - Superior (Peitoral, Costas, Ombros e Braços)',
        description: 'Tronco completo com empurrar e puxar equilibrados para simetria.',
        exercises: upperExercises,
      },
      {
        name: 'Treino B - Inferior (Pernas, Glúteos, Panturrilhas e Core)',
        description: 'Membros inferiores com foco em força, sustentação e estabilidade pélvica.',
        exercises: lowerExercises,
      }
    )
  } else {
    // Full Body
    const usedFB = new Set()
    const fbSquat = chooseExercise(['3593', '1027', '9702'], safeRestrictions, '1027', seedNum, usedFB)
    const fbChest = chooseExercise(['0025', '0289', '1030'], safeRestrictions, '0289', seedNum + 1, usedFB)
    const fbBack = chooseExercise(['0150', '9698', '0180'], safeRestrictions, '0150', seedNum + 2, usedFB)
    const fbHam = chooseExercise(['1060', '3415', '1409'], safeRestrictions, '1060', seedNum + 3, usedFB)
    const fbShoulder = chooseExercise(['0334', '11060', '0178'], safeRestrictions, '0334', seedNum + 4, usedFB)
    const fbCore = chooseExercise(['3777', '4170'], safeRestrictions, '3777', seedNum + 5, usedFB)

    const fullBodyExercisesA = [
      buildExerciseItem(fbSquat, objective, level, safeRestrictions, 'Padrão dominante de joelhos/quadril.'),
      buildExerciseItem(fbChest, objective, level, safeRestrictions, 'Empurrar horizontal com controle escapular.'),
      buildExerciseItem(fbBack, objective, level, safeRestrictions, 'Puxada ampla com controle de tronco.'),
      buildExerciseItem(fbHam, objective, level, safeRestrictions, 'Ativação vigorosa da cadeia posterior.'),
      buildExerciseItem(fbShoulder, objective, level, safeRestrictions, 'Isolamento de deltoides sem balanço.'),
    ]
    if (level === 'avancado') {
      fullBodyExercisesA.push(buildExerciseItem(fbCore, objective, level, safeRestrictions, 'Ativação isométrica de tronco.'))
    }

    divisions.push({
      name: 'Treino A - Full Body (Corpo Inteiro)',
      description: 'Estímulo metabólico e neuromuscular completo em uma única sessão.',
      exercises: fullBodyExercisesA,
    })
  }

  // Adjust focus area if requested
  if (focus === 'gluteos_pernas' && split === 'ppl') {
    const legsDiv = divisions.find(d => d.name.includes('Legs'))
    if (legsDiv && !legsDiv.exercises.some(e => e.id === '1060')) {
      legsDiv.exercises.unshift(buildExerciseItem('1060', objective, level, safeRestrictions, 'Foco prioritário: Elevação pélvica pesada.'))
    }
  }

  const objObj = OBJECTIVES.find(o => o.id === objective) || OBJECTIVES[0]
  const splitObj = SPLITS.find(s => s.id === split) || SPLITS[0]
  const levelObj = LEVELS.find(l => l.id === level) || LEVELS[1]

  const totalExercises = divisions.reduce((acc, d) => acc + d.exercises.length, 0)
  const frequencyText = split === 'ppl' ? '3x a 5x por semana' : split === 'upper_lower' ? '4x por semana' : '3x por semana'

  const notesLines = [
    `Prescrição expressa gerada pelo Copiloto de Treino com IA do PR Fit.`,
    `Objetivo: ${objObj.label} · Divisão: ${splitObj.label} · Nível: ${levelObj.label}.`,
    safeRestrictions.length ? `Restrições articulares tratadas com segurança: ${safeRestrictions.map(r => r.toUpperCase()).join(', ')}.` : null,
    safetyNotes.join(' '),
  ].filter(Boolean)

  return {
    name: `Treino ${objObj.label} ${splitObj.id.toUpperCase()}`,
    frequency: frequencyText,
    notes: notesLines.join('\n'),
    objective,
    split,
    level,
    restrictions: safeRestrictions,
    focus,
    summary: {
      totalExercises,
      estimatedDurationMinutes: level === 'iniciante' ? 45 : level === 'avancado' ? 65 : 55,
      safetyNotes,
    },
    divisions,
    exercises: divisions.flatMap(d => d.exercises.map(ex => ({
      id: ex.id,
      sets: Number(ex.sets),
      reps: ex.reps,
      load: ex.load,
      restSeconds: Number(ex.restSeconds),
      notes: ex.notes,
    }))),
  }
}
