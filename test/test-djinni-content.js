/**
 * Djinni content-script tests. Runs the REAL content.js inside jsdom.
 *
 * The apply form comes from test/fixtures/djinni-apply-form-logged-in.html, a reconstruction of the REAL
 * logged-in form (real tags/ids/names/classes/labels). It is wrapped in a minimal djinni.co vacancy page here
 * (sidebar + the two opener buttons that sit outside any <form>). The logged-out saved page
 * (djinni-vacancy.html) is used for host-scoping and submit-safety checks.
 *
 * Not covered by jsdom: the real TomSelect library (a tiny stub with setValue stands in), the site's own JS
 * that reveals the form / salary input (tests flip style.display / the d-none class themselves).
 */

"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ext = path.join(__dirname, "..", "extension");
const read = (p) => fs.readFileSync(path.join(ext, p), "utf8");
const fixture = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
const VACANCY_URL = "https://djinni.co/jobs/852626-fullstack-engineer-typescript-ai-integration/";

// Same load() harness as test-form-integration.js
function load(html, url = "https://djinni.co/jobs/854193-senior-full-stack-tech-lead-ai-native/") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const w = dom.window;
  let listener = null;
  w.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: (m, cb) => cb && cb({})
    },
    storage: {
      local: {
        get: (k, cb) => {
          const res = { resumeFile: { base64: "eA==", fileName: "resume-candidate.pdf", mimeType: "application/pdf" } };
          return cb ? cb(res) : Promise.resolve(res);
        }
      }
    }
  };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    set(v) { this.textContent = v; }
  });
  w.CSS = w.CSS || {};
  w.CSS.escape = w.CSS.escape || ((s) => String(s).replace(/[^\w-]/g, "\\$&"));
  w.eval(read("shared/default-profile.js"));
  w.eval(read("content/form-helpers.js"));
  w.eval(read("content/content.js"));
  const send = (msg) => new Promise((resolve) => { listener(msg, {}, resolve); });
  return { w, document: w.document, send, close: () => w.close() };
}

const APPLIED_OK_PAGE = `<body>
  <div class="alert alert-success">
    Джин відправив ваш відгук роботодавцю. Бажаємо успіху! Відкрити діалог →
  </div>
  <main>
    <h1>Senior Full-Stack Tech Lead (AI-native)</h1>
    <div>Ви вже відгукнулись на цю вакансію. Відкрити діалог →</div>
  </main>
</body>`;

// D) Djinni jobs list page (filter/search, NOT a vacancy)
const LIST_PAGE_HTML = `<body>
  <main>
    <h1>Вакансії</h1>
    <form method="GET" action="/jobs/">
      <input name="primary_keyword" value="JavaScript">
      <select name="employment"><option value="remote">Remote</option></select>
    </form>
    <div class="jobs-list">
      <article>Job 1</article>
      <article>Job 2</article>
    </div>
  </main>
</body>`;


// Minimal djinni.co vacancy page around the real logged-in apply form. Openers are outside the form, as on the site
// (the main-column one is type="submit" but not in a form).
function vacancyPage({ formHtml = fixture("djinni-apply-form-logged-in.html"), aside = "" } = {}) {
  return `<body>
  <main>
    <h1>Fullstack Engineer</h1>
    <button type="submit" class="btn btn-primary js-inbox-toggle-reply-form js-analytics-event">Відгукнутися на вакансію</button>
    ${formHtml}
  </main>
  <aside>
    ${aside}
    <button type="button" class="btn btn-primary w-100 mb-3 js-inbox-toggle-reply-form js-analytics-event">Відгукнутися на вакансію</button>
  </aside>
</body>`;
}
const openForm = (p) => { p.document.getElementById("apply_form").style.display = "block"; };

// Stand-in for TomSelect: records setValue calls and applies the value to the native select.
function installTomSelectStub(p) {
  const sel = p.document.querySelector("select[name='cv_file_upload_id']");
  const calls = [];
  sel.tomselect = { setValue: (v) => { calls.push(v); sel.value = v; } };
  return calls;
}

console.log("▶ Testing Djinni content-script integration against the real logged-in apply form...");

(async () => {
  // ── A) form closed (style display:none) vs open ──────────────────────────
  {
    const p = load(vacancyPage({ aside: "<ul><li>Ваші очікування: $4000</li></ul>" }), VACANCY_URL);
    const closed = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.strictEqual(closed.formClosed, true, JSON.stringify(closed));
    assert.strictEqual(closed.openerLabel, "Відгукнутися на вакансію");
    assert.strictEqual(closed.alreadyApplied, false);
    assert.strictEqual(closed.salaryFitHint, "Ваші очікування: $4000");
    openForm(p);
    const open = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.strictEqual(open.formClosed, false, JSON.stringify(open));
    assert.strictEqual(open.submitDenied, true);
    p.close();
    console.log("✔ A) hidden #apply_form -> formClosed:true (+ salary hint); shown -> formClosed:false");
  }

  // ── B) open form: exact fields, nothing from templates / settings ────────
  {
    const p = load(vacancyPage(), VACANCY_URL);
    openForm(p);
    const r = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.deepStrictEqual(Array.from(r.fields).map((f) => f.fieldId), ["djinni_message", "djinni_resume", "djinni_salary"]);
    const [msg, resume, salary] = r.fields;
    assert.strictEqual(msg.minLength, 50);
    assert.strictEqual(msg.type, "textarea");
    assert.deepStrictEqual(Array.from(resume.options), ["resume-candidate.pdf", "Не показувати резюме"]);
    assert.strictEqual(resume.value, "resume-candidate.pdf");
    assert.strictEqual(salary.overrideOpen, false);
    assert.strictEqual(salary.openerLabel, "Змінити для цієї вакансії");
    assert.strictEqual(salary.currentDisplay, "4000");
    const all = JSON.stringify(r);
    assert.ok(!/save_msg_template|msg_template_name|Шаблони|Додати резюме/.test(all), "template / settings controls must be excluded");
    p.close();
    console.log("✔ B) fields: message(minLength 50), resume(options by text, selected), salary(override closed); templates excluded");
  }

  // ── Q) recruiter screening questions ─────────────────────────────────────
  {
    const p = load(vacancyPage(), VACANCY_URL);
    openForm(p);
    const r = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.strictEqual(r.questions.length, 1, JSON.stringify(r.questions));
    const q = r.questions[0];
    assert.strictEqual(q.fieldId, "answer_169876");
    assert.strictEqual(q.label, "English How many years of commercial experience do you have with AI integration?");
    assert.strictEqual(q.type, "number");
    assert.strictEqual(q.required, true);
    assert.strictEqual(q.humanRequired, true);
    assert.strictEqual(q.knockout, true);

    const fill = await p.send({ action: "INJECT_AI_ANSWERS", answers: { answer_169876: "4" } });
    assert.deepStrictEqual(Array.from(fill.filled), ["answer_169876"]);
    assert.strictEqual(p.document.getElementById("answer_numeric_1").value, "4");
    // by label too
    await p.send({ action: "INJECT_AI_ANSWERS", answers: { [q.label]: "5" } });
    assert.strictEqual(p.document.getElementById("answer_numeric_1").value, "5");
    p.close();
    console.log("✔ Q) quiz question returned (label/type/required/fieldId, humanRequired+knockout) and fillable by name or label");
  }

  // Quiz variants: several questions, select, radio group
  {
    const extra = `
      <div class="mb-3"><label for="answer_text_2">Why us?</label><textarea id="answer_text_2" name="answer_2"></textarea></div>
      <div class="mb-3"><label for="answer_sel_3">Level</label><select id="answer_sel_3" name="answer_3" required><option value="">--</option><option value="a">Junior</option><option value="b">Senior</option></select></div>
      <div class="mb-3"><span class="form-label">Relocate?</span>
        <input type="radio" id="r1" name="answer_4" value="y"><label for="r1">Так</label>
        <input type="radio" id="r2" name="answer_4" value="n"><label for="r2">Ні</label></div>`;
    const form = fixture("djinni-apply-form-logged-in.html").replace('<h3>Повідомлення та контакти</h3>', extra + "<h3>Повідомлення та контакти</h3>");
    const p = load(vacancyPage({ formHtml: form }), VACANCY_URL);
    openForm(p);
    const r = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.deepStrictEqual(Array.from(r.questions).map((q) => q.fieldId), ["answer_169876", "answer_2", "answer_3", "answer_4"]);
    assert.ok(r.questions.every((q) => q.humanRequired));
    assert.deepStrictEqual(Array.from(r.questions[2].options), ["--", "Junior", "Senior"]);
    assert.deepStrictEqual(Array.from(r.questions[3].options), ["Так", "Ні"]);
    const fill = await p.send({ action: "INJECT_AI_ANSWERS", answers: { answer_2: "Because", answer_3: "Senior", answer_4: "Ні" } });
    assert.deepStrictEqual(Array.from(fill.failed), []);
    assert.strictEqual(p.document.getElementById("answer_text_2").value, "Because");
    assert.strictEqual(p.document.getElementById("answer_sel_3").value, "b");
    assert.strictEqual(p.document.getElementById("r2").checked, true);
    p.close();
    console.log("✔ Q2) several quiz questions: textarea / select / radio group returned and filled");
  }

  // ── E) submit denied; no .js-inbox/submit click ever happens ──────────────
  {
    const p = load(vacancyPage(), VACANCY_URL);
    openForm(p);
    let submitClicked = false;
    p.document.getElementById("job_apply").addEventListener("click", () => { submitClicked = true; });
    for (const label of ["Надіслати відгук", "  надіслати ВІДГУК ", "Submit", "Apply"]) {
      const r = await p.send({ action: "CLICK_BUTTON", text: label });
      assert.strictEqual(r.success, false, `${label}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.denied, true);
    }
    assert.strictEqual(submitClicked, false);
    p.close();
    console.log('✔ E) click_button("Надіслати відгук") denied on the real form; #job_apply never clicked');
  }

  // ── F) openers allowed (even the type=submit one outside a form); salary toggle reveals input ──
  {
    const p = load(vacancyPage(), VACANCY_URL);
    let openerClicks = 0;
    p.document.querySelectorAll(".js-inbox-toggle-reply-form").forEach((b) => b.addEventListener("click", (e) => { openerClicks++; e.preventDefault(); }));
    const r = await p.send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" });
    assert.strictEqual(r.success, true, JSON.stringify(r));
    assert.strictEqual(openerClicks, 1);
    openForm(p);
    const salaryInput = p.document.querySelector("input[name='salary_changed']");
    salaryInput.closest("form").addEventListener("click", () => {});
    p.document.querySelector(".js-salary-toggle-btn").addEventListener("click", () => {
      salaryInput.classList.remove("d-none");
      p.document.querySelector(".js-salary-cancel-btn").classList.remove("d-none");
    });
    const t = await p.send({ action: "CLICK_BUTTON", text: "Змінити для цієї вакансії" });
    assert.strictEqual(t.success, true, JSON.stringify(t));
    assert.ok(!salaryInput.classList.contains("d-none"));
    const state = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.strictEqual(state.fields.find((f) => f.fieldId === "djinni_salary").overrideOpen, true);
    p.close();
    console.log("✔ F) openers + 'Змінити для цієї вакансії' clickable; override state reflected");
  }

  // ── H) fill: message, resume via TomSelect.setValue, salary (hidden -> not filled; open -> filled) ──
  {
    const p = load(vacancyPage(), VACANCY_URL);
    openForm(p);
    const tsCalls = installTomSelectStub(p);
    const text = "Мене зацікавила ця роль: я пишу fullstack TypeScript та працюю з AI-агентами щодня.";

    // salary input still d-none and the site JS not wired -> reported failed, never forced
    const first = await p.send({ action: "INJECT_AI_ANSWERS", answers: { djinni_message: text, djinni_resume: "Не показувати резюме", djinni_salary: "5500" } });
    assert.deepStrictEqual(Array.from(first.filled).sort(), ["djinni_message", "djinni_resume"]);
    assert.strictEqual(first.failed.length, 1);
    assert.ok(/djinni_salary/.test(first.failed[0]));
    assert.deepStrictEqual(tsCalls, [""], "TomSelect.setValue used with the option value");

    // now reveal override (what the site's JS does on toggle) and fill
    p.document.querySelector("input[name='salary_changed']").classList.remove("d-none");
    const second = await p.send({ action: "INJECT_AI_ANSWERS", answers: { djinni_salary: "5500", djinni_resume: "resume-candidate.pdf" } });
    assert.deepStrictEqual(Array.from(second.filled).sort(), ["djinni_resume", "djinni_salary"]);
    assert.deepStrictEqual(tsCalls, ["", "1000001"]);

    const bad = await p.send({ action: "INJECT_AI_ANSWERS", answers: { djinni_resume: "nope.pdf" } });
    assert.ok(/not found/.test(bad.failed[0]));

    // get_form_state shows real values (selected option text for the resume)
    const st = await p.send({ action: "GET_FORM_STATE", maxValueLength: 200, includeEmpty: true });
    const byLabel = (re) => st.fields.find((f) => re.test(f.label));
    assert.strictEqual(byLabel(/Повідомлення/).value, text);
    assert.strictEqual(byLabel(/Резюме/).value, "resume-candidate.pdf", JSON.stringify(st.fields));
    assert.ok(st.fields.some((f) => f.value === "5500"), JSON.stringify(st.fields));
    p.close();
    console.log("✔ H) fill: message, resume (TomSelect.setValue), salary (only once override is open); get_form_state shows real values");
  }

  // ── H2) resume without TomSelect: native value + input/change events ──────
  {
    const p = load(vacancyPage(), VACANCY_URL);
    openForm(p);
    const events = [];
    const sel = p.document.querySelector("select[name='cv_file_upload_id']");
    ["input", "change"].forEach((e) => sel.addEventListener(e, () => events.push(e)));
    const r = await p.send({ action: "INJECT_AI_ANSWERS", answers: { djinni_resume: "Не показувати резюме" } });
    assert.deepStrictEqual(Array.from(r.filled), ["djinni_resume"]);
    assert.strictEqual(sel.value, "");
    assert.deepStrictEqual(events, ["input", "change"]);
    p.close();
    console.log("✔ H2) resume fallback sets select.value and dispatches input+change");
  }

  // ── C) Already-applied detection ─────────────────────────────────────────
  {
    // Test with ?applied=ok URL
    const p = load(APPLIED_OK_PAGE,
      "https://djinni.co/jobs/854193-senior-full-stack-tech-lead-ai-native/?applied=ok");
    const result = await p.send({ action: "GET_SUBMISSION_STATUS" });
    assert.strictEqual(result.isSubmitted, true,
      `Expected isSubmitted: true, got: ${JSON.stringify(result)}`);
    p.close();
    console.log("✔ C) Djinni ?applied=ok → isSubmitted: true");
  }

  {
    // Test with "Джин відправив" banner text
    const p = load(APPLIED_OK_PAGE);
    const result = await p.send({ action: "GET_SUBMISSION_STATUS" });
    assert.strictEqual(result.isSubmitted, true,
      `Expected isSubmitted: true via banner text, got: ${JSON.stringify(result)}`);
    p.close();
    console.log("✔ C) Djinni banner text 'Джин відправив ваш відгук' → isSubmitted: true");
  }

  {
    // "Ви вже відгукнулись" on a fresh visit (not ?applied=ok)
    const alreadyAppliedHtml = `<body><main>
      <h1>Senior Full-Stack Tech Lead</h1>
      <div>Ви вже відгукнулись на цю вакансію. Відкрити діалог →</div>
    </main></body>`;
    const p = load(alreadyAppliedHtml);
    const result = await p.send({ action: "GET_SUBMISSION_STATUS" });
    assert.strictEqual(result.isSubmitted, true,
      `Expected isSubmitted: true via 'ви вже відгукнулись', got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.alreadyApplied, true,
      `Expected alreadyApplied: true on fresh visit (no ?applied=ok)`);
    p.close();
    console.log("✔ C) Djinni 'Ви вже відгукнулись' without ?applied=ok → isSubmitted: true, alreadyApplied: true");
  }

  // ── D) Djinni list page → notAVacancyPage: true ─────────────────────────
  {
    const p = load(LIST_PAGE_HTML, "https://djinni.co/jobs/?primary_keyword=javascript&employment=remote");
    const result = await p.send({ action: "GET_ACTIVE_FORM" });
    assert.strictEqual(result.notAVacancyPage, true,
      `Expected notAVacancyPage: true on Djinni list page, got: ${JSON.stringify(result)}`);
    assert.ok(result.reason && result.reason.length > 0, "must include a reason message");
    p.close();
    console.log("✔ D) Djinni jobs list page → notAVacancyPage: true");
  }

  // ── G) click_button("Відгукнутися на вакансію") DENIED on non-Djinni ──────
  {
    // Same button text but on a non-Djinni URL
    const otherSiteHtml = `<body><button type="button">Відгукнутися на вакансію</button></body>`;
    const p = load(otherSiteHtml, "https://jobs.example.com/vacancy/123");
    const result = await p.send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" });
    assert.strictEqual(result.success, false,
      `"Відгукнутися на вакансію" must be denied on non-Djinni pages, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.denied, true);
    p.close();
    console.log('✔ G) click_button("Відгукнутися на вакансію") denied on non-Djinni pages');
  }

  // ── I) Host scoping + the real saved page: opener/salary labels never work off-Djinni; submit never works anywhere
  {
    const hosts = [
      "https://jobs.example.com/jobs/1-x/",
      "https://djinni.co.evil.com/jobs/1-x/",
      "https://notdjinni.co/jobs/1-x/",
      "https://evil.com/djinni.co/jobs/1-x/"
    ];
    const html = `<body><button type="button">Відгукнутися на вакансію</button><button type="button">Змінити для цієї вакансії</button><button type="submit">Надіслати відгук</button></body>`;
    for (const url of hosts) {
      for (const label of ["Відгукнутися на вакансію", "Змінити для цієї вакансії", "Надіслати відгук", "надіслати  ВІДГУК"]) {
        const p = load(html, url);
        const r = await p.send({ action: "CLICK_BUTTON", text: label });
        assert.strictEqual(r.success, false, `${label} must be denied on ${url}: ${JSON.stringify(r)}`);
        assert.strictEqual(r.denied, true);
        p.close();
      }
    }
    // djinni vacancy page: submit is denied for every case/whitespace variant, and the real submit button is never clicked
    const real = load(fs.readFileSync(path.join(__dirname, "fixtures", "djinni-vacancy.html"), "utf8"));
    let submitClicked = false;
    real.document.getElementById("job_apply").addEventListener("click", () => { submitClicked = true; });
    real.document.getElementById("apply_form").style.display = "block";
    for (const label of ["Надіслати відгук", "  надіслати ВІДГУК ", "Submit", "Apply"]) {
      const r = await real.send({ action: "CLICK_BUTTON", text: label });
      assert.strictEqual(r.success, false, `${label}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.denied, true);
    }
    assert.strictEqual(submitClicked, false, "real #job_apply button must never be clicked");
    real.close();
    console.log("✔ I) opener/salary labels denied off djinni.co (incl. look-alike hosts); submit denied on the real saved page");
  }

  console.log("✔ All Djinni content-script tests passed!");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
