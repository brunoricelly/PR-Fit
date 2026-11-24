import { NUDGE_COPY } from './nudge-copy.js';
import { lineIndex } from './nudge.js';

const COPY = {
  en: {
    restTitle: 'Rest over 💪',
    restBody: 'Time for your next set.',
    testBody: 'Test notification ✅ This is what alerts look like.',
    dayFallbackTitle: 'Workout planned today',
    dayRoutineSuffix: 'today',
    dayBody: "It's on your plan. Let's go 💪",
    stalledTitle: 'Your coach is thinking of you',
    stalledBody: "It's been {0} days since your last workout. Even a short session gets you back on track 💪",
    stalledNeverBody: 'Your plan is ready whenever you are. Start with a short session 💪',
    messageTitle: 'New message',
    messageBody: '{0} sent you a message.',
    messageBodyAnon: 'You have a new message.',
  },
  'pt-BR': {
    restTitle: 'Descanso terminado 💪',
    restBody: 'Hora da próxima série.',
    testBody: 'Notificação de teste ✅ É assim que os alertas aparecem.',
    dayFallbackTitle: 'Treino planejado para hoje',
    dayRoutineSuffix: 'hoje',
    dayBody: 'Está no seu plano. Bora treinar 💪',
    stalledTitle: 'Seu treinador pensou em você',
    stalledBody: 'Faz {0} dias desde o seu último treino. Até uma sessão curta coloca você de volta no ritmo 💪',
    stalledNeverBody: 'Seu plano está pronto quando você quiser. Comece com um treino curto 💪',
    messageTitle: 'Nova mensagem',
    messageBody: '{0} enviou uma mensagem para você.',
    messageBodyAnon: 'Você tem uma nova mensagem.',
  },
};

const copyFor = lang => COPY[lang] || COPY.en;

// A routine's `emoji` field held a literal emoji until the glyph redesign; since then it holds
// an icon key ('dumbbell', 'figureRun') that the app renders as an SVG. A push notification has
// no SVG to render, so an unmapped key reaches the phone as its own name — "dumbbell Push
// today". Keys are ASCII and emoji are not, so anything ASCII is looked up here (falling back
// rather than printing a word), and anything else is already an emoji and passes through.
// Mirrors frontend/src/lib/glyphs.js: GLYPHS is the full set the picker offers.
const DEFAULT_EMOJI = '🏋️';
const GLYPH_EMOJI = {
  figureStrength: '🏋️', arm: '💪', abs: '💥', legs: '🦵', pullup: '🧗',
  dumbbell: '🏋️', barbell: '🏋️', kettlebell: '🏋️', plate: '🏋️', machine: '🏋️',
  figureRun: '🏃', bike: '🚴', swim: '🏊', boxing: '🥊', timer: '⏱️',
  stretch: '🤸', moon: '🌙', heart: '❤️', flame: '🔥', bolt: '⚡',
};

export function routineEmoji(value) {
  if (!value) return DEFAULT_EMOJI;
  if (!/^[A-Za-z]+$/.test(value)) return value;
  return GLYPH_EMOJI[value] || DEFAULT_EMOJI;
}

export function restTimerPush(lang) {
  const copy = copyFor(lang);
  return { title: copy.restTitle, body: copy.restBody, tag: 'rest-timer' };
}

export function testPush(lang) {
  return { title: 'openGym', body: copyFor(lang).testBody, tag: 'test' };
}

export function dayReminderPush(lang, routine) {
  const copy = copyFor(lang);
  return {
    title: routine
      ? `${routineEmoji(routine.emoji)} ${routine.name} ${copy.dayRoutineSuffix}`
      : copy.dayFallbackTitle,
    body: copy.dayBody,
    tag: 'day-reminder',
  };
}

// The missed-workout nudge (nudge.js). Its copy is translated in the frontend packs and generated
// into nudge-copy.js, so every language the app speaks has it — unlike the strings above, which
// predate that and fall back to English. de-CH is de with ß written ss, as in the frontend
// (lib/i18n-core.js DERIVED_LOCALES).
const nudgeCopyFor = lang => {
  if (lang === 'de-CH') {
    const ch = s => s.replace(/ß/g, 'ss');
    return Object.fromEntries(Object.entries(NUDGE_COPY.de).map(([k, c]) => [k, { title: ch(c.title), lines: c.lines.map(ch) }]));
  }
  return NUDGE_COPY[lang] || NUDGE_COPY.en;
};
export function nudgePush(lang, tone, routine, iso) {
  const copy = nudgeCopyFor(lang)[NUDGE_COPY.en[tone] ? tone : 'friendly'];
  const line = copy.lines[lineIndex(iso, copy.lines.length)];
  const name = routine?.name || 'openGym';
  return { title: copy.title, body: line.replace('{0}', () => name), tag: 'nudge' };
}

// The stalled-athlete push (stalled.js). `days` is how long since the last workout; null for an
// athlete who has not logged one yet. Other languages fall back to English, like the strings above.
export function stalledPush(lang, days) {
  const copy = copyFor(lang);
  return {
    title: copy.stalledTitle,
    body: days == null ? copy.stalledNeverBody : copy.stalledBody.replace('{0}', String(days)),
    tag: 'stalled',
  };
}

// A coach <-> athlete message. The text never rides in the push (lock screens are public); only who
// it is from. One tag per link so a burst replaces itself instead of stacking.
export function messagePush(lang, senderName, linkId) {
  const copy = copyFor(lang);
  const name = typeof senderName === 'string' ? senderName.trim().slice(0, 40) : '';
  return {
    title: copy.messageTitle,
    body: name ? copy.messageBody.replace('{0}', name) : copy.messageBodyAnon,
    tag: `msg-${String(linkId).slice(0, 40)}`,
  };
}

export function appointmentReminderPush(idempotencyKey) {
  return {
    type: 'appointment_reminder',
    idempotencyKey,
    title: 'Upcoming appointment',
    body: 'Your scheduled appointment starts soon.',
    tag: idempotencyKey,
  };
}
