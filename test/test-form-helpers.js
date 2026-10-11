const assert = require("assert");
const { fhClassifyFileInput, fhCleanLabel, fhIsMeaningfulLabel, fhPickLabel, fhSubmissionByUrl } = require("../extension/content/form-helpers.js");

console.log("▶ Testing form helpers (file-input classifier, labels, submission URLs)...");

const cls = (d) => fhClassifyFileInput({ label: "", ariaLabel: "", name: "", id: "", placeholder: "", accept: "", surroundingText: "", ...d });

// Resume inputs
assert.strictEqual(cls({ label: "Resume", accept: ".pdf,.doc,.docx" }).passed, true);
assert.strictEqual(cls({ label: "Autofill from resume" }).passed, true);
assert.strictEqual(cls({ name: "cv_file" }).passed, true);
assert.strictEqual(cls({ label: "Резюме" }).passed, true);
assert.strictEqual(cls({ label: "Attach", surroundingText: "Resume/CV Attach" }).passed, true);
assert.strictEqual(cls({ label: "Curriculum Vitae", accept: "application/pdf" }).passed, true);

// Never a resume
assert.strictEqual(cls({ label: "Photo", accept: ".jpg,.jpeg,.gif,.png" }).passed, false);
assert.strictEqual(cls({ label: "Resume", accept: "image/*" }).passed, false, "image-only accept beats the label");
assert.strictEqual(cls({ label: "Profile picture" }).passed, false);
assert.strictEqual(cls({ label: "Upload video / Allow access" }).passed, false);
assert.strictEqual(cls({ label: "Upload video", accept: "video/*" }).weak, false);
assert.strictEqual(cls({ label: "Cover image" }).passed, false);
assert.strictEqual(cls({ label: "Attach", surroundingText: "Photo (optional) Attach" }).passed, false);

// Word boundaries: "cv" must not match inside other words
assert.strictEqual(cls({ label: "CSV import" }).passed, false);
assert.strictEqual(cls({ label: "Cover letter" }).passed, false);
assert.strictEqual(cls({ label: "Upload file" }).weak, true, "unlabeled document-capable input is only a weak candidate");
assert.strictEqual(cls({ label: "Resume", accept: ".exe" }).passed, false, "accept excluding documents");

// Labels
assert.strictEqual(fhCleanLabel("First name* Required"), "First name");
assert.strictEqual(fhCleanLabel("  Location (City)*\n"), "Location (City)");
assert.strictEqual(fhIsMeaningfulLabel("*"), false);
assert.strictEqual(fhIsMeaningfulLabel("on"), false);
assert.strictEqual(fhIsMeaningfulLabel("Search"), false);
assert.strictEqual(fhIsMeaningfulLabel("Years of React"), true);
assert.strictEqual(fhPickLabel(["*", "", "Required", "How many years of React?*", "x"]), "How many years of React?");
assert.strictEqual(fhPickLabel(["*", "on"]), null);

// Submission URLs
for (const u of ["https://a.com/o/job/applied", "https://a.com/apply/confirm/AbC?source=LILI", "https://a.com/thank-you", "https://a.com/connect/dashboard", "https://a.com/jobs/1/submitted"]) {
  assert.strictEqual(fhSubmissionByUrl(u), true, u);
}
for (const u of ["https://a.com/jobs/1/apply", "https://a.com/success-stories", "https://a.com/confirmed-customers", "not a url"]) {
  assert.strictEqual(fhSubmissionByUrl(u), false, u);
}

// Application scope: a hidden duplicate form (closed "Refer a friend" modal, same field names, one more
// field so it would out-score the real form) must not win; with no rendered form we fall back to the best.
{
  const { JSDOM } = require("jsdom");
  const { fhGetApplicationScope } = require("../extension/content/form-helpers.js");
  const form = (id, n) =>
    `<form id="${id}">${Array.from({ length: n }, (_, i) => `<input name="f${i}">`).join("")}` +
    `<input type="file" name="cv"><button>SUBMIT APPLICATION</button></form>`;
  const scope = (html) => fhGetApplicationScope(new JSDOM(html).window.document);

  const glorium = scope(
    `<div style="display:none">${form("ref1", 8)}</div><div hidden>${form("ref2", 8)}</div>${form("real", 7)}`
  );
  assert.strictEqual(glorium.id, "real", "visible form must beat higher-scoring hidden forms");

  const allHidden = scope(`<div style="display:none">${form("a", 5)}${form("b", 8)}</div>`);
  assert.strictEqual(allHidden.id, "b", "all hidden: fall back to the best-scoring form");
}

console.log("✔ Form helpers tests passed!");
