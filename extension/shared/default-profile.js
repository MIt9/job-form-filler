// Candidate profile schema. Ships EMPTY: every user fills their own data in the popup
// (Profile tab) or imports a JSON file. Stored in chrome.storage.local as `candidateData`.
//
// PROFILE_FIELDS drives both the popup editor and Tier-1 autofill: adding a field here
// is the only step needed for it to appear in the editor. `options` renders a <select>.
// Labels are English; the popup localizes them via _locales (keys field_<path> / section_<id>).
// `translatable` fields may hold per-language values in `localized.<lang>.<path>`, used when a
// form is in that language (e.g. city "Vinnytsia" vs "Вінниця").
// `var` (not const): popup/background may re-inject this file into a frame that already has it.
var YES_NO = ["", "Yes", "No"];

// Languages whose forms are recognized (content.js FIELD_RULES) and that can hold translations.
var FORM_LANGUAGES = {
  en: "English",
  uk: "Українська",
  pl: "Polski",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pt: "Português",
  nl: "Nederlands"
};

var PROFILE_FIELDS = [
  { section: "personal", label: "Personal" },
  { path: "personal.firstName", label: "First name", translatable: true },
  { path: "personal.lastName", label: "Last name", translatable: true },
  { path: "personal.preferredName", label: "Preferred name", translatable: true },
  { path: "personal.pronouns", label: "Pronouns" },
  { path: "personal.email", label: "Email", type: "email" },
  { path: "personal.phoneCountryCode", label: "Dial code", placeholder: "+380" },
  { path: "personal.phone", label: "Phone", type: "tel", placeholder: "+380 XX XXX XX XX" },
  { path: "personal.address", label: "Street address", translatable: true },
  { path: "personal.city", label: "City", translatable: true },
  { path: "personal.state", label: "State / region", translatable: true },
  { path: "personal.postalCode", label: "Postal code" },
  { path: "personal.country", label: "Country", placeholder: "Ukraine" },

  { section: "links", label: "Links" },
  { path: "links.linkedin", label: "LinkedIn", type: "url" },
  { path: "links.github", label: "GitHub", type: "url" },
  { path: "links.website", label: "Website / portfolio", type: "url" },
  { path: "links.twitter", label: "X / Twitter", type: "url" },

  { section: "work", label: "Work" },
  { path: "work.currentCompany", label: "Current company", translatable: true },
  { path: "work.currentTitle", label: "Current title", translatable: true },
  { path: "work.yearsOfExperience", label: "Years of experience", placeholder: "10" },
  { path: "work.noticePeriod", label: "Notice period", placeholder: "2 weeks", translatable: true },
  { path: "work.startDate", label: "Can start", placeholder: "Immediately", translatable: true },
  { path: "work.salaryExpectation", label: "Salary expectation", translatable: true },
  { path: "work.englishLevel", label: "English level", placeholder: "C1 / Fluent", translatable: true },
  { path: "work.howDidYouHear", label: "How did you hear", placeholder: "LinkedIn", translatable: true },

  { section: "legal", label: "Legal & EEO" },
  { path: "legal.authorizedToWork", label: "Authorized to work", options: YES_NO },
  { path: "legal.requiresSponsorship", label: "Needs visa sponsorship", options: YES_NO },
  { path: "legal.willingToRelocate", label: "Willing to relocate", options: YES_NO },
  { path: "eeo.gender", label: "Gender (EEO)", placeholder: "empty = decline" },
  { path: "eeo.ethnicity", label: "Ethnicity (EEO)", placeholder: "empty = decline" },
  { path: "eeo.veteran", label: "Veteran (EEO)", placeholder: "empty = decline" },
  { path: "eeo.disability", label: "Disability (EEO)", placeholder: "empty = decline" }
];

// Optional role variants: { "<id>": { title, summary } }. Lets one person keep several
// framings (e.g. "frontend-developer", "engineering-manager") and pick one per application.
var DEFAULT_CANDIDATE_DATA = {
  personal: {},
  links: {},
  work: {},
  legal: {},
  eeo: {},
  profiles: {},
  localized: {}
};

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = value;
}

// Field classification key (content.js FIELD_RULES) → profile path. Used to learn the profile
// back from a form the user filled by hand. EEO is deliberately absent: it defaults to "decline"
// and is only ever set explicitly in the editor or by the user via MCP.
var PROFILE_KEY_PATHS = {
  firstName: "personal.firstName",
  lastName: "personal.lastName",
  preferredName: "personal.preferredName",
  pronouns: "personal.pronouns",
  email: "personal.email",
  phoneDialCode: "personal.phoneCountryCode",
  phone: "personal.phone",
  address: "personal.address",
  city: "personal.city",
  state: "personal.state",
  postalCode: "personal.postalCode",
  country: "personal.country",
  linkedin: "links.linkedin",
  github: "links.github",
  twitter: "links.twitter",
  website: "links.website",
  currentCompany: "work.currentCompany",
  currentTitle: "work.currentTitle",
  yearsOfExperience: "work.yearsOfExperience",
  noticePeriod: "work.noticePeriod",
  startDate: "work.startDate",
  salary: "work.salaryExpectation",
  englishLevel: "work.englishLevel",
  howDidYouHear: "work.howDidYouHear",
  workAuthorization: "legal.authorizedToWork",
  sponsorship: "legal.requiresSponsorship",
  relocation: "legal.willingToRelocate"
};

function profileFieldLabel(path) {
  return PROFILE_FIELDS.find((f) => f.path === path)?.label || path;
}

/**
 * Merges a partial profile into `current` without mutating it. Only known editor paths,
 * localized.<lang>.<translatable path> and profiles.<id>.title|summary are accepted (the patch may come from an AI agent over the bridge).
 * Existing non-empty values are kept unless `overwrite`; differing ones are reported as conflicts.
 */
function mergeProfile(current, patch, overwrite = false) {
  const data = structuredClone(current || DEFAULT_CANDIDATE_DATA);
  const result = { data, changed: [], conflicts: [], ignored: [] };
  const allowed = new Set(PROFILE_FIELDS.filter((f) => f.path).map((f) => f.path));
  const translatable = new Set(PROFILE_FIELDS.filter((f) => f.translatable).map((f) => f.path));

  const walk = (obj, prefix) => {
    Object.entries(obj || {}).forEach(([k, v]) => {
      const path = prefix ? `${prefix}.${k}` : k;
      if (/(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(path)) return result.ignored.push(path);
      if (v && typeof v === "object" && !Array.isArray(v)) return walk(v, path);
      const local = path.match(/^localized\.([a-z]{2})\.(.+)$/);
      const known =
        allowed.has(path) ||
        /^profiles\.[\w-]+\.(title|summary)$/.test(path) ||
        (local && FORM_LANGUAGES[local[1]] && translatable.has(local[2]));
      if (!known || !["string", "boolean"].includes(typeof v)) return result.ignored.push(path);
      const value = typeof v === "boolean" ? (v ? "Yes" : "No") : v.trim().slice(0, 5000);
      if (!value) return;
      const old = getPath(data, path);
      if (old === value) return;
      if (old && !overwrite) return result.conflicts.push({ path, current: old, proposed: value });
      setPath(data, path, value);
      result.changed.push(path);
    });
  };
  if (patch && typeof patch === "object" && !Array.isArray(patch)) walk(patch, "");
  return result;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_CANDIDATE_DATA, PROFILE_FIELDS, FORM_LANGUAGES, PROFILE_KEY_PATHS, getPath, setPath, mergeProfile, profileFieldLabel };
}
