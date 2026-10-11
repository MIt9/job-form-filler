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

const { loadProfiles, resolveDefaultResumeRepoPath } = require("../server/profile-loader");
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

(async () => {
  console.log("▶ Testing multilingual Tier 3 detection...");
  const { isHumanRequiredQuestion } = require("../server/human-questions");
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

  fs.rmSync(repo, { recursive: true, force: true });
  console.log("✔ Multilingual Tier 3 tests passed!");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
