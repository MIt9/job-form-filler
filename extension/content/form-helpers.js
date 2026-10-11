// Shared form helpers. Loaded before content.js (manifest content_scripts) so its functions are
// globals for content.js; also require()-able in tests. Pure/DOM-light on purpose.

(function () {
// ---- Labels -------------------------------------------------------------------------------
const FH_GENERIC_LABEL_RE = /^(\*|required|optional|on|off|yes|no|search|select\.{0,3}|choose\.{0,3})$/i;

// "First name* Required" -> "First name"
function fhCleanLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(?\brequired\b\)?\s*$/i, "")
    .replace(/\s*\*+\s*$/g, "")
    .trim();
}

function fhIsMeaningfulLabel(text) {
  const t = fhCleanLabel(text);
  return t.length > 1 && /[\p{L}\p{N}]/u.test(t) && !FH_GENERIC_LABEL_RE.test(t);
}

// First meaningful candidate, cleaned; null when none (callers fall back to name/id).
function fhPickLabel(candidates) {
  for (const c of candidates || []) {
    if (fhIsMeaningfulLabel(c)) return fhCleanLabel(c);
  }
  return null;
}

// ---- File inputs (resume vs photo) ---------------------------------------------------------
const FH_RESUME_RE = /\b(resume|résumé|cv|curriculum(?:\s+vitae)?)\b|резюме|życiorys|lebenslauf|currículo|curriculo/i;
const FH_PHOTO_RE = /\b(photo|avatar|picture|headshot|profile\s*image|logo|cover\s*image|image|video|audio|loom)\b|фото|відео|zdjęcie|foto\b/i;

// descriptor: {label, ariaLabel, name, id, placeholder, accept, surroundingText}
// -> {passed, weak, reason}. passed = clearly a resume input; weak = unlabeled document-capable input.
function fhClassifyFileInput(d) {
  // snake_case / kebab-case / dotted names ("cv_file", "resume-upload") must split into words for \b matching.
  const words = (s) => String(s || "").replace(/[_\-./\[\]]+/g, " ");
  const own = words([d.label, d.ariaLabel, d.name, d.id, d.placeholder].filter(Boolean).join(" "));
  const around = words(d.surroundingText);
  const accept = String(d.accept || "").toLowerCase();
  const tokens = accept.split(",").map((s) => s.trim()).filter(Boolean);
  const imageOnly = tokens.length > 0 && tokens.every((t) => /^image\//.test(t) || /\.(jpe?g|png|gif|webp|bmp|svg)$/.test(t));
  const hasDocTypes = tokens.length === 0 || tokens.some((t) => /pdf|msword|officedocument|opendocument|rtf|\.docx?$|\.odt$|\.rtf$|\.txt$/.test(t));

  if (imageOnly) return { passed: false, weak: false, reason: "accept allows only images" };
  if (!hasDocTypes) return { passed: false, weak: false, reason: "accept excludes documents" };

  const ownResume = FH_RESUME_RE.test(own);
  const ownPhoto = FH_PHOTO_RE.test(own);
  if (ownPhoto && !ownResume) return { passed: false, weak: false, reason: "labelled as photo/avatar/image/video" };
  if (ownResume) return { passed: true, weak: false, reason: null };

  // Label is generic ("Attach", "Upload file"): decide by the surrounding question text.
  const aroundResume = FH_RESUME_RE.test(around);
  const aroundPhoto = FH_PHOTO_RE.test(around);
  if (aroundResume && !aroundPhoto) return { passed: true, weak: false, reason: null };
  if (aroundPhoto) return { passed: false, weak: false, reason: "surrounding text says photo/image" };
  return { passed: false, weak: true, reason: "no resume keywords" };
}

// ---- Scope: only the real application form --------------------------------------------------
const FH_NOISE_SELECTOR = [
  "header", "footer", "nav",
  '[role="banner"]', '[role="contentinfo"]', '[role="navigation"]', '[role="search"]',
  '[id*="cookie" i]', '[class*="cookie" i]', '[aria-label*="cookie" i]',
  '[id*="onetrust" i]', '[class*="onetrust" i]', '[class*="cookiebot" i]', '[id*="cookiebot" i]',
  ".iti__dropdown-content", ".iti__country-list", ".iti__search-input", '[id*="__search-input"]',
  // embedded video players (video.js caption settings: Color / Opacity / Font Family ...)
  ".video-js", '[class*="vjs-"]', '[class*="video-player" i]'
].join(", ");

function fhIsLoginForm(form) {
  if (!form) return false;
  if (form.querySelector('input[type="password"]')) return true;
  return /login|sign-?in|sso|log-?in/i.test(form.getAttribute("action") || "");
}

// True when el sits in site chrome (header/footer/nav/cookie banner/country list) or a login form.
function fhIsNoise(el) {
  if (!el || !el.closest) return false;
  if (el.closest(FH_NOISE_SELECTOR)) return true;
  return fhIsLoginForm(el.closest("form"));
}

const FH_SUBMIT_RE = /submit|apply|send application|відправити|подати|надіслати|bewerben|postuler/i;
const FH_FIELD_SELECTOR = "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select";

// False when el or an ancestor is display:none / visibility:hidden (e.g. a closed "Refer a friend" modal
// that has the same field names as the real form). Works without layout (jsdom), unlike offsetWidth.
function fhIsRendered(el) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (!view) return true;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const s = view.getComputedStyle(n);
    if (s.display === "none" || s.visibility === "hidden") return false;
  }
  return true;
}

// Returns the container of the application form, or null (callers then use the whole document).
function fhGetApplicationScope(doc) {
  const candidates = Array.from(doc.querySelectorAll("form")).filter(
    (f) => !fhIsNoise(f) && !fhIsLoginForm(f) && f.querySelectorAll(FH_FIELD_SELECTOR).length >= 3
  );
  // Prefer rendered forms; if none is rendered (late render, odd CSS) keep the old behaviour.
  const rendered = candidates.filter(fhIsRendered);
  const forms = rendered.length ? rendered : candidates;
  const score = (f) => {
    let s = Math.min(f.querySelectorAll(FH_FIELD_SELECTOR).length, 30);
    if (f.querySelector("input[type='file']")) s += 50;
    const btn = Array.from(f.querySelectorAll("button, input[type='submit']")).find((b) => FH_SUBMIT_RE.test(b.textContent || b.value || ""));
    if (btn) s += 30;
    return s;
  };
  if (forms.length) return forms.sort((a, b) => score(b) - score(a))[0];

  for (const dialog of Array.from(doc.querySelectorAll("[role='dialog']"))) {
    if (fhIsNoise(dialog)) continue;
    if (dialog.querySelectorAll(FH_FIELD_SELECTOR).length >= 3 && !fhIsLoginForm(dialog.querySelector("form"))) return dialog;
  }
  return null;
}

// ---- Submission detection by URL ------------------------------------------------------------
const FH_SUBMITTED_URL_RE = /\/(?:confirm(?:ation)?|applied|thank-?you|thanks|success|submitted|connect\/dashboard)(?:\/|$)/i;

function fhSubmissionByUrl(url) {
  try {
    return FH_SUBMITTED_URL_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const api = {
  fhCleanLabel,
  fhIsMeaningfulLabel,
  fhPickLabel,
  fhClassifyFileInput,
  fhIsNoise,
  fhIsLoginForm,
  fhGetApplicationScope,
  fhSubmissionByUrl
};
// A namespace (not bare globals) so injecting the file twice (manifest + executeScript fallback) is harmless.
globalThis.__JFF_HELPERS = globalThis.__JFF_HELPERS || api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
