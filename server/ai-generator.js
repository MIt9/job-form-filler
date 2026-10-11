const Anthropic = require("@anthropic-ai/sdk");
const { loadProfiles } = require("./profile-loader");

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

const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : v || null);

// Answers only what the structured profile states verbatim. Anything else is left for the
// LLM or the human: a canned free-text answer reads like the candidate's own words, which
// is worse than an empty field. Values come from localized.<language> first (the candidate's own
// translation); "Yes"/"No" are translated by the extension when written into a text input.
function answerFromProfile(q, c, language) {
  const label = (q.label || "").toLowerCase();
  const pick = (section, key) => c.localized?.[language]?.[section]?.[key] || c[section]?.[key] || null;
  if (/sponsor|\bvisa\b|віз[аиу](?![а-яіїєґ])|wiz[ayę](?![a-ząćęłńóśźż])|visum|patroc[ií]nio|parrainage|\bvisto\b|sponsorizzazione/.test(label)) return yesNo(pick("legal", "requiresSponsorship"));
  if (/authori[sz]ed|right to work|eligible to work|work permit|дозв[іо]л на роботу|pozwoleni[ea] na pracę|arbeitserlaubnis|permis de travail|permiso de trabajo|permesso di lavoro|autorização de trabalho|werkvergunning/.test(label)) {
    return yesNo(pick("legal", "authorizedToWork"));
  }
  if (/relocat|релокац|переїзд|relokac|przeprowadz|umzug|déménag|reubica|trasferi|realoca|mudar-se|verhuiz/.test(label)) return yesNo(pick("legal", "willingToRelocate"));
  if (/notice|попередження|wypowiedzenia|kündigungsfrist|préavis|preaviso|preavviso|aviso prévio|opzegtermijn/.test(label)) return pick("work", "noticePeriod");
  if (/start date|when can you start|available to start|дата початку|приступити|data rozpoczęcia|eintritt|date de début|fecha de inicio|data di inizio|data de início|startdatum/.test(label)) {
    return pick("work", "startDate") || pick("work", "noticePeriod");
  }
  if (/salary|compensation|pay expectation|зарплат|заробітн|wynagrodzeni|gehalt|salaire|salario|salarial|retribuzione|stipendio|salário|remuneração|salaris/.test(label)) return pick("work", "salaryExpectation");
  if (/english|англійськ|angielsk|englisch|anglais|inglés|inglese|inglês|\bengels\b/.test(label)) return pick("work", "englishLevel");
  if (/how did you hear|hear about|звідки .*дізнал|skąd .*dowiedział|erfahren|connu|enteraste|enteró|come (hai|ha) (saputo|conosciuto)|como (soube|conheceu)|gehoord/.test(label)) return pick("work", "howDidYouHear");
  if (/years.{0,25}experience|років досвіду|lat doświadczenia|jahre.{0,20}erfahrung|années d'expérience|años de experiencia|anni di esperienza|anos de experiência|jaren.{0,10}ervaring/.test(label) &&
      !/(^|\s)(with|using|з|із|w|mit|avec|con|com|met)\s/.test(label)) {
    return pick("work", "yearsOfExperience");
  }
  return null;
}

/**
 * Answers custom application questions.
 * candidateData comes from the extension (popup profile); profileKey picks an optional role
 * variant from RESUME_REPO_PATH, whose resume markdown is the only source of experience facts.
 */
async function generateAnswers({ jobTitle, company, jobDescription = "", profileKey, candidateData = {}, language = "en", questions = [] }) {
  const variant = profileKey ? loadProfiles().profiles[profileKey] || candidateData.profiles?.[profileKey] : null;

  const answers = {};
  const humanRequiredQuestions = [];
  const remaining = [];

  questions.forEach((q) => {
    const fromProfile = answerFromProfile(q, candidateData, language);
    if (fromProfile) answers[q.fieldId] = fromProfile;
    else if (isHumanRequiredQuestion(q)) {
      humanRequiredQuestions.push({
        fieldId: q.fieldId,
        label: q.label,
        type: q.type,
        reason: "Requires personal human experience, motivation, or tradeoff decision (Tier 3: Never auto-generated to prevent hallucination)"
      });
    } else remaining.push(q);
  });

  let unanswered = remaining;
  if (process.env.ANTHROPIC_API_KEY && remaining.length > 0) {
    try {
      Object.assign(answers, await generateViaAnthropic({ jobTitle, company, jobDescription, variant, candidateData, language, questions: remaining }));
      unanswered = remaining.filter((q) => !answers[q.fieldId]);
    } catch (err) {
      console.warn("[AIGenerator] Anthropic API call failed:", err.message);
    }
  }

  return {
    success: true,
    answers,
    humanRequiredQuestions,
    // No LLM configured (or it declined): these need the human or an external agent (MCP).
    unansweredQuestions: unanswered.map((q) => ({ fieldId: q.fieldId, label: q.label }))
  };
}

async function generateViaAnthropic({ jobTitle, company, jobDescription, variant, candidateData, language, questions }) {
  const { personal = {}, work = {}, links = {} } = candidateData;
  const facts = variant?.fullMarkdown || variant?.summary || "";

  const prompt = `Fill out job application questions for the candidate below.

Candidate: ${[personal.firstName, personal.lastName].filter(Boolean).join(" ")}
Current role: ${work.currentTitle || "?"} at ${work.currentCompany || "?"}; ${work.yearsOfExperience || "?"} years of experience
Links: ${Object.values(links).filter(Boolean).join(", ")}
${candidateData.localized?.[language] ? `Candidate's own spelling of their details in this language: ${JSON.stringify(candidateData.localized[language])}\n` : ""}${variant?.title ? `Target framing: ${variant.title}\n` : ""}
Resume (the ONLY source of experience facts):
${facts || "(not provided)"}

Company: ${company}
Role: ${jobTitle}
Job description:
${jobDescription.slice(0, 3000)}

Questions:
${JSON.stringify(questions, null, 2)}

Rules:
- Answer each question keyed by its fieldId. For questions with options, answer with one option text verbatim.
- Write every free-text answer in the form's language: "${language}" (ISO 639-1), even though the resume may be in another language.
- Use only facts stated in the resume above. Never invent numbers, team sizes, tools, how often something is used, or degrees.
- If the resume does not support an answer, return an empty string for that fieldId.`;

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    // Server-side fallback re-runs the request on another model if this one declines.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: Object.fromEntries(questions.map((q) => [q.fieldId, { type: "string" }])),
          required: questions.map((q) => q.fieldId),
          additionalProperties: false
        }
      }
    },
    messages: [{ role: "user", content: prompt }]
  });

  if (response.stop_reason === "refusal") throw new Error("model declined the request");
  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  return Object.fromEntries(Object.entries(JSON.parse(text)).filter(([, v]) => v));
}

module.exports = {
  generateAnswers,
  isHumanRequiredQuestion
};
