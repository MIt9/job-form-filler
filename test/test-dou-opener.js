"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = `<body><form class="search"><input name="q"></form>
<a id="open" href="#apply">Відгукнутися<span> на вакансію</span></a>
<form id="replied-id" class="replied" style="display:none"><textarea name="reply"></textarea>
<input type="file" name="cv"><button id="send" type="submit">Відправити</button></form></body>`;

function load() {
  const w = new JSDOM(html, { runScripts: "outside-only", url: "https://jobs.dou.ua/companies/x/vacancies/1/", pretendToBeVisual: true }).window;
  let listener;
  w.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage: (_m, cb) => cb && cb({}) }, storage: { local: { get: (_k, cb) => (cb ? cb({}) : Promise.resolve({})) } } };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  w.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, "\\$&") };
  for (const f of ["shared/default-profile.js", "content/form-helpers.js", "content/content.js"])
    w.eval(fs.readFileSync(path.join(__dirname, "../extension", f), "utf8"));
  return { w, send: (m) => new Promise((r) => listener(m, {}, r)) };
}

(async () => {
  const { w, send } = load();
  const d = w.document;
  let submits = 0;
  d.getElementById("send").addEventListener("click", () => submits++);
  d.getElementById("open").addEventListener("click", (e) => { e.preventDefault(); d.getElementById("replied-id").style.display = "block"; });
  const denied = await send({ action: "CLICK_BUTTON", text: "Відправити" });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(submits, 0, "submit must never be clicked");
  const r = await send({ action: "CLICK_BUTTON", text: "Відгукнутися на вакансію" });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.formClosed, false);
  const form = await send({ action: "GET_JOB_AND_QUESTIONS" });
  assert.ok((form.questions || []).some((q) => q.label === "reply"), "textarea visible after opening");
  assert.strictEqual(submits, 0);
  w.close();
  console.log("ok dou opener");
})().catch((e) => { console.error(e); process.exit(1); });
