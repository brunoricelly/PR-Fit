/* Allow-list for the AI workout builder: the exercises the rules generator already knows, with
 * their joint-stress flags. The model may only pick from this list; ai-workout.js rejects any other id.
 * Generated from frontend/src/lib/ai-workout-copilot.js (EXERCISE_KNOWLEDGE + PT names). */
export const AI_CATALOGUE = Object.freeze([
 {
  "id": "0025",
  "name": "Supino reto com barra",
  "muscle": "Peitoral",
  "equipment": "Barra",
  "compound": true,
  "shoulder": true,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0289",
  "name": "Supino reto com halteres",
  "muscle": "Peitoral",
  "equipment": "Halteres",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0047",
  "name": "Supino inclinado com barra",
  "muscle": "Peitoral",
  "equipment": "Barra",
  "compound": true,
  "shoulder": true,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1030",
  "name": "Voador / Peck Deck na máquina",
  "muscle": "Peitoral",
  "equipment": "Máquina",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0662",
  "name": "Flexão de braços no solo",
  "muscle": "Peitoral",
  "equipment": "Peso corporal",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0169",
  "name": "Supino inclinado no cabo",
  "muscle": "Peitoral",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "2982",
  "name": "Supino no chão com halteres (pegada neutra)",
  "muscle": "Peitoral",
  "equipment": "Halteres",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0091",
  "name": "Desenvolvimento de ombros com barra sentado",
  "muscle": "Ombros",
  "equipment": "Barra",
  "compound": true,
  "shoulder": true,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "2137",
  "name": "Desenvolvimento Arnold com halteres",
  "muscle": "Ombros",
  "equipment": "Halteres",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0334",
  "name": "Elevação lateral com halteres",
  "muscle": "Ombros",
  "equipment": "Halteres",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0178",
  "name": "Elevação lateral no cabo",
  "muscle": "Ombros",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "11060",
  "name": "Face pull no cabo com rotação externa",
  "muscle": "Deltoide posterior",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "5607",
  "name": "Face pull com pegada neutra",
  "muscle": "Deltoide posterior",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1609",
  "name": "Tríceps na polia alta",
  "muscle": "Tríceps",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0306",
  "name": "Tríceps testa com halteres",
  "muscle": "Tríceps",
  "equipment": "Halteres",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1033",
  "name": "Tríceps na máquina",
  "muscle": "Tríceps",
  "equipment": "Máquina",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0172",
  "name": "Tríceps polia com corda",
  "muscle": "Tríceps",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0027",
  "name": "Remada curvada com barra",
  "muscle": "Dorsais",
  "equipment": "Barra",
  "compound": true,
  "shoulder": false,
  "lumbar": true,
  "knee": false
 },
 {
  "id": "0150",
  "name": "Puxada frontal aberta no cabo",
  "muscle": "Dorsais",
  "equipment": "Cabo",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0180",
  "name": "Remada baixa sentada no cabo",
  "muscle": "Dorsais",
  "equipment": "Cabo",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0652",
  "name": "Barra fixa (Pull-up)",
  "muscle": "Dorsais",
  "equipment": "Peso corporal",
  "compound": true,
  "shoulder": true,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1047",
  "name": "Puxada frontal pegada fechada/neutra",
  "muscle": "Dorsais",
  "equipment": "Cabo",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "9698",
  "name": "Remada com apoio no peito com halteres",
  "muscle": "Dorsais",
  "equipment": "Halteres",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0294",
  "name": "Rosca bíceps com halteres",
  "muscle": "Bíceps",
  "equipment": "Halteres",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0031",
  "name": "Rosca direta com barra",
  "muscle": "Bíceps",
  "equipment": "Barra",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1646",
  "name": "Rosca martelo com halteres",
  "muscle": "Bíceps",
  "equipment": "Halteres",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1032",
  "name": "Rosca bíceps na máquina",
  "muscle": "Bíceps",
  "equipment": "Máquina",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "3593",
  "name": "Agachamento livre com barra",
  "muscle": "Quadríceps",
  "equipment": "Barra",
  "compound": true,
  "shoulder": false,
  "lumbar": true,
  "knee": true
 },
 {
  "id": "1027",
  "name": "Leg press 45° articulado",
  "muscle": "Quadríceps",
  "equipment": "Máquina",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "5664",
  "name": "Cadeira extensora no cabo",
  "muscle": "Quadríceps",
  "equipment": "Cabo",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "9702",
  "name": "Agachamento goblet",
  "muscle": "Quadríceps",
  "equipment": "Halteres",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1060",
  "name": "Elevação pélvica com barra (Hip Thrust)",
  "muscle": "Glúteos",
  "equipment": "Barra",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1409",
  "name": "Ponte de glúteos no solo",
  "muscle": "Glúteos",
  "equipment": "Barra",
  "compound": true,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "4173",
  "name": "Stiff / RDL com barra",
  "muscle": "Isquiotibiais",
  "equipment": "Barra",
  "compound": true,
  "shoulder": false,
  "lumbar": true,
  "knee": false
 },
 {
  "id": "3415",
  "name": "Mesa / Cadeira flexora",
  "muscle": "Isquiotibiais",
  "equipment": "Máquina",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1034",
  "name": "Cadeira abdutora na máquina",
  "muscle": "Glúteos",
  "equipment": "Máquina",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0417",
  "name": "Elevação de panturrilha em pé com halteres",
  "muscle": "Panturrilhas",
  "equipment": "Halteres",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "1372",
  "name": "Elevação de panturrilha em pé com barra",
  "muscle": "Panturrilhas",
  "equipment": "Barra",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "0472",
  "name": "Elevação de pernas na barra",
  "muscle": "Abdômen",
  "equipment": "Barra",
  "compound": false,
  "shoulder": true,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "3777",
  "name": "Prancha frontal isométrica",
  "muscle": "Core",
  "equipment": "Peso corporal",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "4170",
  "name": "Prancha de urso isométrica",
  "muscle": "Core",
  "equipment": "Peso corporal",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 },
 {
  "id": "5265",
  "name": "Abdominal supra no solo",
  "muscle": "Abdômen",
  "equipment": "Peso corporal",
  "compound": false,
  "shoulder": false,
  "lumbar": false,
  "knee": false
 }
].map(Object.freeze));
