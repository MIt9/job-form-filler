const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Mirrors the REAL resume repo: profiles in <repo>/resume/<profile>/, a log with an intro, newest-first
// "## Skipped" blocks and a table whose rows have 5 cells (the notes live in the 5th cell after " — ").
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jff-real-layout-"));
fs.mkdirSync(path.join(repo, "info"), { recursive: true });
fs.mkdirSync(path.join(repo, "resume", "frontend-developer"), { recursive: true });
fs.writeFileSync(
  path.join(repo, "info", "applications-log.md"),
  [
    "# Applications Log",
    "",
    "Master index of vacancies.",
    "",
    "## Skipped — Old (2026-10-01): Role, frontend-developer profile, https://old.example/1 — reason",
    "",
    "| Date | Company | Role | Profile | Folder / notes |",
    "|---|---|---|---|---|",
    "| 2026-10-01 | Prev | Dev | frontend-developer | `resume/frontend-developer/applications/prev/` — note |",
    "",
    "By profile:",
    "",
  ].join("\n")
);
fs.writeFileSync(
  path.join(repo, "resume", "frontend-developer", "resume-dmytro-bilukha.md"),
  [
    "# Name",
    "",
    "## Applications submitted under this profile",
    "",
    "- **Prev** — Dev — see `applications/prev/`",
    "",
    "---",
    "",
    "## Interests",
    "",
    "- Wrestling",
    "",
  ].join("\n")
);
process.env.RESUME_REPO_PATH = repo;
const { logApplication } = require("../server/log-application.js");

(async () => {
  console.log("▶ Testing log_application against the real repo layout...");

  // profile validation uses resume/<profile>
  await assert.rejects(() => logApplication({ company: "X", role: "Y", profile: "nope", status: "submitted" }), /frontend-developer/);

  // skipped: new block goes above the previous newest block, one blank line between, no double blank above
  await logApplication({ company: "NewSkip", role: "Eng", profile: "frontend-developer", url: "https://new.example/2", status: "skipped", notes: "UK only" });
  let log = fs.readFileSync(path.join(repo, "info", "applications-log.md"), "utf8").split("\n");
  const newIdx = log.findIndex((l) => l.startsWith("## Skipped — NewSkip"));
  const oldIdx = log.findIndex((l) => l.startsWith("## Skipped — Old"));
  assert.strictEqual(log[newIdx - 1], "", "blank line above the new block");
  assert.notStrictEqual(log[newIdx - 2], "", "no double blank line above the new block");
  assert.strictEqual(oldIdx, newIdx + 2, "exactly one blank line between new and old block");

  // submitted: 5-cell row with the folder and the notes in one cell, nested resume/<profile>/ path
  const res = await logApplication({ company: "Acme Inc", role: "Senior Dev", profile: "frontend-developer", url: "https://acme.example/3", status: "submitted", notes: "has | pipe" });
  assert.strictEqual(res.alreadyLogged, false);
  log = fs.readFileSync(path.join(repo, "info", "applications-log.md"), "utf8").split("\n");
  const row = log.find((l) => l.includes("| Acme Inc |"));
  const cells = row.replace(/\\\|/g, "").split("|").slice(1, -1);
  assert.strictEqual(cells.length, 5, `row must have 5 cells, got ${cells.length}: ${row}`);
  assert(row.includes("`resume/frontend-developer/applications/acme-inc/` — has \\| pipe"), row);
  assert(log.indexOf(row) > log.findIndex((l) => l.includes("| Prev |")), "row goes after the last table row");

  // profile list: bullet lands inside the section, before '---' and '## Interests'
  const md = fs.readFileSync(path.join(repo, "resume", "frontend-developer", "resume-dmytro-bilukha.md"), "utf8").split("\n");
  const b = md.findIndex((l) => l.startsWith("- **Acme Inc**"));
  assert(b > md.findIndex((l) => l.startsWith("- **Prev**")) && b < md.findIndex((l) => l.startsWith("## Interests")), "bullet inside the Applications section");
  assert.strictEqual(md[b - 1].startsWith("- **Prev**"), true, "directly after the last bullet");
  assert(fs.existsSync(path.join(repo, "resume", "frontend-developer", "applications", "acme-inc", "job-posting.md")));

  // Regression: the same company name in an OLD table plus today's date elsewhere must not count as "already logged"
  // (checkAlreadyLogged used two loose substring checks over the whole file).
  fs.appendFileSync(
    path.join(repo, "info", "applications-log.md"),
    "\n| Company | Profile | Reason |\n|---|---|---|\n| OldCo | frontend-developer | foundational gap |\n"
  );
  const old = await logApplication({ company: "OldCo", role: "Dev", profile: "frontend-developer", url: "https://old.example/9", status: "skipped", notes: "new vacancy at an old company" });
  assert.strictEqual(old.alreadyLogged, false, "same company in an unrelated old table is not a duplicate");

  // Two different vacancies at one company on the same day are both logged (URL is the identity)...
  const first = await logApplication({ company: "Dual Corp", role: "A", profile: "frontend-developer", url: "https://dual.example/1", status: "skipped", notes: "n" });
  const second = await logApplication({ company: "Dual Corp", role: "B", profile: "frontend-developer", url: "https://dual.example/2", status: "skipped", notes: "n" });
  assert.strictEqual(first.alreadyLogged, false);
  assert.strictEqual(second.alreadyLogged, false, "different URL, same company and day");
  // ...but the same URL twice is a duplicate.
  assert.strictEqual((await logApplication({ company: "Dual Corp", role: "A", profile: "frontend-developer", url: "https://dual.example/1", status: "skipped" })).alreadyLogged, true);

  // Company names with regex metacharacters must not break matching or throw.
  const paren = await logApplication({ company: "Ciklum (Indeed [dup]) + Co.", role: "Dev", profile: "frontend-developer", status: "skipped", notes: "no url" });
  assert.strictEqual(paren.alreadyLogged, false);
  assert.strictEqual((await logApplication({ company: "Ciklum (Indeed [dup]) + Co.", role: "Dev", profile: "frontend-developer", status: "skipped" })).alreadyLogged, true, "no-URL duplicate by exact company+date");

  // idempotent
  assert.strictEqual((await logApplication({ company: "Acme Inc", role: "Senior Dev", profile: "frontend-developer", url: "https://acme.example/3", status: "submitted" })).alreadyLogged, true);

  console.log("✔ log_application real-layout tests passed!");
})().catch((e) => { console.error(e); process.exit(1); });
