
/**
 * Checks if a question is Tier 3 (human-required / behavioral / personal / motivational tradeoff)
 * that must NEVER be auto-filled by AI to prevent hallucinations, cadence claims, or fake stories.
 * Covers every form language the extension recognizes (en, uk, pl, de, fr, es, it, pt, nl).
 */
const HUMAN_PATTERNS = [
  // en
  /reasonable\s+person\s+(?:could|might)\s+disagree/,
  /decision\s+you\s+made/,
  /beyond\s+(?:any\s+)?ai/,
  /something\s+about\s+you/,
  /tell\s+us\s+about\s+a\s+time/,
  /describe\s+a\s+(?:situation|time)/,
  /proudest|biggest\s+(?:mistake|failure)|\bconflict\b/,
  /why\s+(?:this\s+company|us\b|now|do\s+you\s+want|are\s+you\s+interested|did\s+you\s+apply)/,
  /what\s+(?:about\s+\w+\s+)?(?:made|makes)\s+you\s+(?:apply|unique)/,
  /tradeoff|trade-off|disagree/,
  /personal\s+project|passion/,
  /how\s+would\s+you\s+handle/,
  // uk
  /розкажіть\s+(про|нам)|опишіть\s+(ситуацію|випадок)|чому\s+(саме\s+)?(ми|наш|ця|ви\s+хочете|зараз)|що\s+вас\s+(мотивує|приваблює)|найбільш\S*\s+(досягнення|помилк)|конфлікт|компроміс|не\s+погодил/,
  // pl
  /opowiedz|opisz\s+sytuacj|dlaczego\s+(chcesz|nasz|ta\s+firma|teraz)|co\s+cię\s+motywuje|największ\S*\s+(sukces|błąd|porażk)|konflikt/,
  // de
  /erzählen\s+sie|beschreiben\s+sie\s+eine\s+situation|warum\s+(möchten\s+sie|wir|uns|jetzt|diese)|was\s+motiviert|größte[rn]?\s+(erfolg|fehler)|konflikt/,
  // fr
  /racontez|décrivez\s+une\s+situation|pourquoi\s+(voulez-vous|nous|maintenant|cette)|qu'est-ce\s+qui\s+vous\s+motive|plus\s+grande?\s+(réussite|erreur)|conflit/,
  // es
  /cuéntanos|cuéntenos|describe\s+una\s+situación|por\s+qué\s+(quieres|nosotros|ahora|esta)|qué\s+te\s+motiva|mayor\s+(logro|error)|conflicto/,
  // it
  /raccontaci|descrivi\s+una\s+situazione|perché\s+(vuoi|noi|ora|questa)|cosa\s+ti\s+motiva|più\s+grande\s+(successo|errore)|conflitto/,
  // pt
  /conte-nos|descreva\s+uma\s+situação|por\s*que\s+(quer|nós|agora|esta)|o\s+que\s+(te|o)\s+motiva|maior\s+(conquista|erro)|conflito/,
  // nl
  /vertel\s+(ons\s+)?over|beschrijf\s+een\s+situatie|waarom\s+(wil\s+je|wilt\s+u|wij|ons|nu|deze)|wat\s+motiveert|grootste\s+(succes|fout)/
];

function isHumanRequiredQuestion(q) {
  const text = `${q.label || ""} ${q.placeholder || ""}`.toLowerCase().replace(/[’ʼ]/g, "'");
  return HUMAN_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = { isHumanRequiredQuestion };
