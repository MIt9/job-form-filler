const assert = require("assert");

// Minimal shims so content.js's top-level IIFE code can load in Node (no real DOM needed —
// classifyField() itself is pure string matching, no document access).
global.window = { location: { hostname: "example.com" } };
// Capture the real onMessage listener content.js registers, so the test below can feed it a
// live UPDATE_PROFILE message (exactly what the popup/background script sends) to seed the
// module-private `learnedAnswers` store — the only way to reach it from outside the IIFE.
let capturedMessageListener = null;
global.chrome = { runtime: { onMessage: { addListener: (fn) => { capturedMessageListener = fn; } } } };

const { classifyField } = require("../extension/content/content.js");

// fullIdentifier is built by content.js as: `${label} | ${name} | ${id} | ${testid} | ${placeholder} | ${autocomplete}`.toLowerCase()
const field = (label, id = "") => `${label} |  | ${id} |  |  | `.toLowerCase();
const key = (label, id, type = "text", autocomplete = "") =>
  classifyField(field(label, id), type, { getAttribute: (a) => (a === "autocomplete" ? autocomplete : null) }).key;

console.log("▶ Testing classifyField against the Paylocity address-block bug report...");

// Regression: these structured address sub-fields all share an "address-" id prefix. They must
// NOT be classified as "location" (which would stuff the candidate's city into them) just because
// their id contains the substring "address". Each now maps to its own profile field.
assert.strictEqual(key("Address Line 1", "public-site-address-address-1"), "address", "Address Line 1 is the street address");
assert.strictEqual(key("Address Line 2 (optional)", "public-site-address-address-2"), "dynamicAI", "Address Line 2 has no profile value");
assert.strictEqual(key("County", "public-site-address-county"), "dynamicAI", "County must not absorb city/country");
assert.strictEqual(key("Zip Code", "public-site-address-zip"), "postalCode", "Zip Code maps to postal code");
assert.strictEqual(key("City", "public-site-address-city"), "city", "City must classify as city");
assert.strictEqual(key("Country", "public-site-address-country"), "country", "Country must classify as country");
assert.strictEqual(key("LinkedIn Profile URL", "linkedInUrl"), "linkedin", "LinkedIn must classify as linkedin");

console.log("✔ classifyField address tests passed!");

console.log("▶ Testing standard field coverage...");
const cases = [
  ["First Name", "", "firstName"],
  ["Last name *", "", "lastName"],
  ["Preferred first name", "", "preferredName"],
  ["Name", "", "fullName"],
  ["Company name", "", "currentCompany"],
  ["Phone", "", "phone"],
  ["Country code", "", "phoneDialCode"],
  ["Location (City)", "", "city"],
  ["Where are you currently based?", "", "location"],
  ["Are you willing to relocate?", "", "relocation"],
  ["Will you now or in the future require visa sponsorship?", "", "sponsorship"],
  ["Are you legally authorized to work in the EU?", "", "workAuthorization"],
  ["State / Province", "", "state"],
  ["Are you located in the United States?", "", "dynamicAI"],
  ["Desired salary", "", "salary"],
  ["What is your notice period?", "", "noticePeriod"],
  ["Earliest start date", "", "startDate"],
  ["How did you hear about us?", "", "howDidYouHear"],
  ["Total years of professional experience", "", "yearsOfExperience"],
  ["Years of experience with Kubernetes", "", "dynamicAI"],
  ["English proficiency", "", "englishLevel"],
  ["Pronouns", "", "pronouns"],
  ["Gender", "", "gender"],
  ["Race / Ethnicity", "", "ethnicity"],
  ["Veteran status", "", "veteran"],
  ["Disability status", "", "disability"],
  ["GitHub", "", "github"],
  ["Portfolio / Website", "", "website"],
  ["Why do you want to join us?", "", "dynamicAI"]
];
cases.forEach(([label, id, expected]) => assert.strictEqual(key(label, id), expected, `"${label}" → ${expected}`));

// autocomplete attribute wins over a vague label; type=email/tel are enough on their own.
assert.strictEqual(key("Field 3", "", "text", "given-name"), "firstName");
assert.strictEqual(key("Field 4", "", "text", "section-a shipping postal-code"), "postalCode");
assert.strictEqual(key("Contact", "", "email"), "email");
assert.strictEqual(key("Contact", "", "tel"), "phone");
// Textareas never take profile values, file inputs are resumes unless labelled cover letter.
assert.strictEqual(key("Name", "", "textarea"), "dynamicAI");
assert.strictEqual(key("Attach", "", "file"), "resumeFile");
assert.strictEqual(key("Cover letter", "", "file"), "coverLetterFile");

console.log("✔ Standard field coverage tests passed!");

console.log("▶ Testing multilingual forms (uk, pl, de, fr, es, it, pt, nl)...");
const multilingual = {
  uk: [
    ["Ім’я", "firstName"], ["Прізвище", "lastName"], ["ПІБ", "fullName"], ["Ім'я та прізвище", "fullName"],
    ["Електронна пошта", "email"], ["Номер телефону", "phone"], ["Місто", "city"], ["Країна проживання", "country"],
    ["Поштовий індекс", "postalCode"], ["Область", "state"], ["Адреса", "address"], ["Посада", "currentTitle"],
    ["Очікування щодо заробітної плати", "salary"], ["Чи потрібна вам віза?", "sponsorship"], ["Чи готові до переїзду?", "relocation"],
    ["Дозвіл на роботу в ЄС", "workAuthorization"], ["Звідки ви дізналися про вакансію?", "howDidYouHear"],
    ["Рівень англійської", "englishLevel"], ["Скільки років досвіду роботи?", "yearsOfExperience"],
    ["Досвід роботи з React", "dynamicAI"], ["Коли можете приступити?", "startDate"], ["Стать", "gender"],
    ["Статус", "dynamicAI"], ["Поштова адреса для листування", "address"], ["Адреса електронної пошти", "email"]
  ],
  pl: [
    ["Imię", "firstName"], ["Nazwisko", "lastName"], ["Imię i nazwisko", "fullName"], ["Miasto", "city"],
    ["Kraj", "country"], ["Kod pocztowy", "postalCode"], ["Oczekiwania finansowe (wynagrodzenie)", "salary"],
    ["Czy potrzebujesz wizy?", "sponsorship"], ["Płeć", "gender"]
  ],
  de: [
    ["Vorname", "firstName"], ["Nachname", "lastName"], ["Straße und Hausnummer", "address"], ["PLZ", "postalCode"],
    ["Ort", "city"], ["Land", "country"], ["Bundesland", "state"], ["Gehaltsvorstellung", "salary"],
    ["Kündigungsfrist", "noticePeriod"], ["Frühestmöglicher Eintrittstermin", "startDate"], ["Geschlecht", "gender"]
  ],
  fr: [
    ["Prénom", "firstName"], ["Nom", "lastName"], ["Nom complet", "fullName"], ["Nom de l'entreprise", "dynamicAI"],
    ["Ville", "city"], ["Pays", "country"], ["Code postal", "postalCode"], ["Prétentions salariales", "salary"], ["Préavis", "noticePeriod"]
  ],
  es: [
    ["Nombre", "firstName"], ["Apellidos", "lastName"], ["Nombre completo", "fullName"], ["Correo electrónico", "email"],
    ["Teléfono", "phone"], ["Ciudad", "city"], ["País", "country"], ["Expectativa salarial", "salary"], ["Estado civil", "dynamicAI"]
  ],
  it: [
    ["Nome", "firstName"], ["Cognome", "lastName"], ["Nome e cognome", "fullName"], ["Nome dell'azienda", "dynamicAI"],
    ["Indirizzo email", "email"], ["Telefono cellulare", "phone"], ["Città", "city"], ["Paese di residenza", "country"],
    ["CAP", "postalCode"], ["Retribuzione desiderata", "salary"], ["Preavviso", "noticePeriod"], ["Hai bisogno di un visto?", "sponsorship"],
    ["Anni di esperienza", "yearsOfExperience"], ["Sesso", "gender"]
  ],
  pt: [
    ["Primeiro nome", "firstName"], ["Sobrenome", "lastName"], ["Nome completo", "fullName"], ["Telefone", "phone"],
    ["Cidade", "city"], ["Nacionalidade", "country"], ["Código postal", "postalCode"], ["Pretensão salarial", "salary"],
    ["Aviso prévio", "noticePeriod"], ["Data de início", "startDate"], ["Gênero", "gender"]
  ],
  nl: [
    ["Voornaam", "firstName"], ["Achternaam", "lastName"], ["Volledige naam", "fullName"], ["Telefoonnummer", "phone"],
    ["Woonplaats", "city"], ["Postcode", "postalCode"], ["Salarisindicatie", "salary"], ["Opzegtermijn", "noticePeriod"],
    ["Heb je een werkvergunning?", "workAuthorization"], ["Geslacht", "gender"], ["Hoe heb je over deze vacature gehoord?", "howDidYouHear"]
  ]
};
Object.entries(multilingual).forEach(([lang, list]) =>
  list.forEach(([label, expected]) => assert.strictEqual(key(label), expected, `[${lang}] "${label}" → ${expected}`))
);
assert.strictEqual(key("Супровідний лист", "", "file"), "coverLetterFile");
assert.strictEqual(key("Lebenslauf hochladen", "", "text"), "resumeFile");
console.log("✔ Multilingual classification tests passed!");

console.log("▶ Testing stale learned-answer replay bug (Paylocity/Angel Studios LinkedIn field)...");

// A learned answer (persisted from an earlier, DOM-corrupted form) must never override a field's
// own authoritative classification: learned answers are checked only after every profile rule misses.
assert(capturedMessageListener, "content.js must register a chrome.runtime.onMessage listener");
capturedMessageListener(
  {
    action: "UPDATE_PROFILE",
    activeProfileKey: null,
    learnedAnswers: { "LinkedIn profile": "https://linkedin.com/in/someone-elseUkraine" }
  },
  {},
  () => {}
);

assert.deepStrictEqual(
  classifyField(field("LinkedIn Profile URL", "LinkedInProfileUrl"), "text"),
  { tier: 1, key: "linkedin" },
  "A stale/corrupted learned answer must never override the field's own authoritative 'linkedin' classification"
);

console.log("✔ Stale learned-answer replay test passed!");

console.log("▶ Testing consent / agreement checkboxes (never auto-checked)...");
const consentCases = [
  "I consent to my applicant data being stored in the saas.group talent pool ... Data is transmitted to other SaaS.Group companies ...",
  "By submitting this application, I agree that I have read the Privacy Policy and confirm that bunny.net store my personal details...",
  "Yes, bunny.net can contact me directly about specific future job opportunities.",
  "Analytics",
  "Marketing"
];

consentCases.forEach((label) => {
  const result = classifyField(field(label), "checkbox");
  assert.deepStrictEqual(result, { type: "consent" }, `"${label}" must classify as { type: "consent" }`);
  assert.notStrictEqual(result.tier, 1, `"${label}" must NOT be tier 1 (should NOT be auto-checked)`);

  // Verify that autofill loop skips any field with type "consent"
  const fieldData = {
    type: result.type,
    classification: result,
    element: { type: "checkbox", checked: false }
  };
  const isSkippedInAutofill = fieldData.type === "consent" || fieldData.classification?.type === "consent";
  assert.strictEqual(isSkippedInAutofill, true, `"${label}" must be skipped in autofill loop`);
  assert.strictEqual(fieldData.element.checked, false, `"${label}" must NOT be auto-checked`);
});


// Legit checkboxes must continue to be classified for autofill (work authorization)
assert.strictEqual(key("Are you legally authorized to work in the EU?", "", "checkbox"), "workAuthorization");
assert.strictEqual(key("Will you now or in the future require visa sponsorship?", "", "checkbox"), "sponsorship");
assert.strictEqual(key("Are you willing to relocate?", "", "checkbox"), "relocation");

console.log("✔ Consent checkbox tests passed!");

