const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Fixture resume repo: <repo>/resume/<role>/<any-name>.md|.pdf
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jff-repo-"));
const roleDir = path.join(repo, "resume", "frontend-developer");
fs.mkdirSync(roleDir, { recursive: true });
fs.writeFileSync(path.join(roleDir, "resume-jane-doe.md"), "# Jane Doe\n\n**Senior Frontend Developer**\n\n## Summary\n\nBuilds fast React apps.\n\n## Experience\n");
fs.writeFileSync(path.join(roleDir, "resume-jane-doe.pdf"), "%PDF-1.4 fake");
fs.mkdirSync(path.join(repo, "resume", "empty-folder"));

process.env.RESUME_REPO_PATH = repo;
process.env.JFF_DATA_DIR = path.join(repo, "data");
delete process.env.ANTHROPIC_API_KEY;

const { loadProfiles, resolveDefaultResumeRepoPath } = require("../server/profile-loader");
const { generateAnswers } = require("../server/ai-generator");
const { saveApplication } = require("../server/app-saver");

console.log("▶ Testing Profile Loader...");
const data = loadProfiles();
assert.deepStrictEqual(data.availableProfiles, ["frontend-developer"], "Only folders with a resume count as role variants");
const fe = data.profiles["frontend-developer"];
assert.strictEqual(fe.title, "Senior Frontend Developer");
assert.strictEqual(fe.summary, "Builds fast React apps.");
assert.strictEqual(fe.pdfFileName, "resume-jane-doe.pdf", "Any resume file name is picked up");
assert.deepStrictEqual(loadProfiles("/nonexistent").profiles, {}, "Missing repo is not an error");

// Test DEFAULT_RESUME_REPO_PATH fallback logic
assert.strictEqual(resolveDefaultResumeRepoPath(), repo, "Uses process.env.RESUME_REPO_PATH when set");
const savedEnv = process.env.RESUME_REPO_PATH;
try {
  delete process.env.RESUME_REPO_PATH;
  assert.strictEqual(resolveDefaultResumeRepoPath(), "", "No guessed location: empty string when unset");
} finally {
  process.env.RESUME_REPO_PATH = savedEnv;
}

console.log("✔ Profile Loader tests passed!");

console.log("▶ Testing app saver...");
const saved = saveApplication({ company: "Acme Corp", jobTitle: "Dev", profileKey: "frontend-developer" });
assert.strictEqual(saved.savedPath, path.join(roleDir, "applications", "acme-corp"));
const savedNoRole = saveApplication({ company: "../../Evil" });
assert(savedNoRole.savedPath.startsWith(path.join(repo, "data", "applications")), "Company name cannot escape the data dir");
console.log("✔ App saver tests passed!");

console.log("▶ Testing AI Generator (grounding, no fabricated answers)...");
(async () => {
  const candidateData = {
    personal: { firstName: "Jane", lastName: "Doe" },
    work: { noticePeriod: "1 month", yearsOfExperience: "8" },
    legal: { requiresSponsorship: "No", authorizedToWork: "Yes" }
  };
  const result = await generateAnswers({
    jobTitle: "Frontend Engineer",
    company: "Acme Corp",
    profileKey: "frontend-developer",
    candidateData,
    questions: [
      { fieldId: "q_visa", label: "Do you require visa sponsorship?", type: "radio-group", options: ["Yes", "No"] },
      { fieldId: "q_auth", label: "Are you authorized to work in the EU?", type: "select" },
      { fieldId: "q_notice", label: "Notice period", type: "text" },
      { fieldId: "q_years", label: "Total years of experience", type: "text" },
      { fieldId: "q_salary", label: "Salary expectations", type: "text" },
      { fieldId: "q_time", label: "Tell us about a time you disagreed with your manager", type: "textarea" },
      { fieldId: "q_cover", label: "Cover Letter", type: "textarea" }
    ]
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.answers.q_visa, "No");
  assert.strictEqual(result.answers.q_auth, "Yes");
  assert.strictEqual(result.answers.q_notice, "1 month");
  assert.strictEqual(result.answers.q_years, "8");
  assert(!("q_salary" in result.answers), "Missing profile value must stay unanswered, not invented");
  assert(!("q_cover" in result.answers), "No canned cover letter without an LLM");
  assert.deepStrictEqual(result.humanRequiredQuestions.map((q) => q.fieldId), ["q_time"]);
  assert.deepStrictEqual(result.unansweredQuestions.map((q) => q.fieldId).sort(), ["q_cover", "q_salary"]);

  console.log("✔ AI Generator tests passed!");

  console.log("▶ Testing multilingual Tier 3 detection and localized profile answers...");
  const { isHumanRequiredQuestion } = require("../server/ai-generator");
  [
    "Розкажіть про випадок, коли ви не погодилися з командою",
    "Чому саме наша компанія?",
    "Raccontaci di un progetto difficile",
    "Por que quer trabalhar connosco?",
    "Waarom wil je bij ons werken?",
    "Opowiedz o sytuacji, w której popełniłeś błąd",
    "Warum möchten Sie bei uns arbeiten?",
    "Pourquoi voulez-vous nous rejoindre ?",
    "¿Por qué quieres trabajar con nosotros?"
  ].forEach((label) => assert(isHumanRequiredQuestion({ label }), `Tier 3: ${label}`));
  ["Ваше місто", "Досвід з візуальним дизайном", "Wie viele Jahre Erfahrung?"].forEach((label) =>
    assert(!isHumanRequiredQuestion({ label }), `Not Tier 3: ${label}`)
  );

  const uk = await generateAnswers({
    company: "Acme",
    language: "uk",
    candidateData: { ...candidateData, localized: { uk: { work: { noticePeriod: "1 місяць" } } } },
    questions: [
      { fieldId: "visa", label: "Чи потрібна вам віза?", type: "radio-group", options: ["Так", "Ні"] },
      { fieldId: "notice", label: "Період попередження", type: "text" },
      { fieldId: "visual", label: "Досвід з візуальним дизайном", type: "textarea" }
    ]
  });
  assert.strictEqual(uk.answers.visa, "No", "Yes/No is matched to Так/Ні by the extension");
  assert.strictEqual(uk.answers.notice, "1 місяць", "Localized profile value wins on a Ukrainian form");
  assert(!("visual" in uk.answers), "'візуальний' must not be read as a visa question");

  fs.rmSync(repo, { recursive: true, force: true });
  console.log("✔ Multilingual generator tests passed!");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
