"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

function load() {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures/djinni-principal-inline.html"), "utf8"), {
    url: "https://djinni.co/jobs/855151-principal-front-end-developer-staff-engineer-/",
    runScripts: "outside-only", pretendToBeVisual: true
  });
  const w = dom.window;
  let listener;
  w.chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage(_m, cb) { if (cb) cb({}); } },
    storage: { local: { get(_k, cb) { return cb ? cb({}) : Promise.resolve({}); } } }
  };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  w.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, "\\$&") };
  for (const file of ["shared/default-profile.js", "content/form-helpers.js", "content/content.js"])
    w.eval(fs.readFileSync(path.join(__dirname, "../extension", file), "utf8"));
  return { w, d: w.document, send: (message) => new Promise((resolve) => listener(message, {}, resolve)) };
}

(async () => {
  const p = load();
  try {
    const { w, d, send } = p;
    let hiddenClicks = 0, visibleClicks = 0, submits = 0;
    d.querySelector("main > div button").addEventListener("click", () => hiddenClicks++);
    d.getElementById("visible-opener").addEventListener("click", (e) => {
      e.preventDefault();
      visibleClicks++;
      // Model async page rendering, rather than manually opening the form after the tool returns.
      w.setTimeout(() => {
        d.getElementById("inline-slot").append(d.getElementById("application-template").content.cloneNode(true));
        d.getElementById("job_apply").addEventListener("click", () => submits++);
      }, 75);
    });
    assert.strictEqual((await send({ action: "GET_JOB_AND_QUESTIONS", full: true })).formClosed, true);
    const clicked = await send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" });
    assert.strictEqual(hiddenClicks, 0, "hidden ancestor opener must never be clicked");
    assert.strictEqual(visibleClicks, 1);
    assert.strictEqual(clicked.success, true);
    assert.strictEqual(clicked.formClosed, false, "click must wait for inline fields, not merely dispatch an event");
    const form = await send({ action: "GET_JOB_AND_QUESTIONS", full: true });
    assert.strictEqual(form.formClosed, false);
    assert.deepStrictEqual(Array.from(form.questions, (q) => q.fieldId), ["answer_101", "answer_102", "answer_103", "answer_104"]);
    assert.ok(form.questions.every((q) => q.knockout && q.type === "textarea" && q.label));
    const resume = form.fields.find((f) => f.fieldId === "djinni_resume");
    assert.deepStrictEqual(Array.from(resume.options), ["candidate.pdf", "Не показувати резюме"]);
    assert.strictEqual(resume.value, "candidate.pdf");
    assert.strictEqual(resume.selectedValue, "12345");
    assert.deepStrictEqual(Array.from(resume.optionDetails, (o) => o.value), ["12345", ""]);
    assert.strictEqual(d.querySelector("input[type=file]"), null);
    assert.ok(form.questions.every((q) => q.value === ""), "opener must not answer humanRequired questions");
    await send({ action: "AUTOFILL_STATIC", candidateData: { work: { startDate: "Immediately", noticePeriod: "2 weeks" } } });
    assert.strictEqual(d.getElementById("start").value, "", "humanRequired start-date answer must not be autofilled from profile");
    // Explicit values represent candidate-provided answers; the extension does not generate answers.
    const answers = { answer_101: "Candidate leadership answer", answer_102: "Candidate AI answer", answer_103: "Candidate startup answer", answer_104: "2026-12-01", djinni_message: "Candidate message", djinni_salary: "5200", djinni_resume: "Не показувати резюме" };
    const filled = await send({ action: "INJECT_AI_ANSWERS", answers });
    assert.deepStrictEqual(Array.from(filled.failed), []);
    assert.deepStrictEqual(Array.from(filled.notFound), []);
    assert.strictEqual(filled.filled.length, 7);
    const state = await send({ action: "GET_FORM_STATE", includeEmpty: true, maxValueLength: 300 });
    for (const [id, value] of Object.entries(answers)) assert.strictEqual(state.fields.find((f) => f.fieldId === id)?.value, value, id);
    assert.strictEqual(d.getElementById("resume").value, "");
    await send({ action: "INJECT_AI_ANSWERS", answers: { djinni_resume: "12345" } });
    assert.strictEqual(d.getElementById("resume").value, "12345", "resume choice may also use the existing uploaded resume ID");
    assert.ok(!state.fields.some((f) => /template|ts-control/.test(f.fieldId)));
    // A repeated opener must not toggle an already open form closed.
    await send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" });
    assert.strictEqual(visibleClicks, 1);
    for (const text of ["Надіслати відгук", "Submit", "Send", "Apply", "Confirm", "Finish", "Delete", "Pay", "+ Додати резюме"])
      assert.strictEqual((await send({ action: "CLICK_BUTTON", text })).denied, true, text);
    // Even an allowed opener label cannot disguise an actual form submitter.
    d.getElementById("visible-opener").remove();
    d.querySelector("aside").remove();
    d.getElementById("job_apply").textContent = "Відгукнутися на вакансію";
    assert.strictEqual((await send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" })).denied, true);
    d.getElementById("job_apply").textContent = "Next";
    assert.strictEqual((await send({ action: "CLICK_BUTTON", text: "Next" })).denied, true);
    assert.strictEqual(submits, 0);
    console.log("✔ Djinni inline: delayed detection, hidden duplicate, four human questions, select/number/textarea roundtrip and submit safety");
  } finally { p.w.close(); }
  const stalled = load();
  try {
    stalled.d.querySelector("main > div").remove();
    stalled.d.getElementById("visible-opener").addEventListener("click", (e) => e.preventDefault());
    const result = await stalled.send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" });
    assert.strictEqual(result.clicked, true);
    assert.strictEqual(result.success, false, "a click without visible fields must not claim success");
    assert.strictEqual(result.formClosed, true);
    assert.strictEqual(result.formReady, false);
    assert.strictEqual((await stalled.send({ action: "GET_ACTIVE_FORM" })).formClosed, true);
    console.log("✔ Djinni opener timeout reports clicked but not ready without forcing the DOM open");
  } finally { stalled.w.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
