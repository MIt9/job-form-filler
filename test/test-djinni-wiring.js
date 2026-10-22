/**
 * Djinni end-to-end wiring: real background.js (vm, stubbed chrome/WebSocket) -> real content.js (jsdom).
 * Drives handleBridgeMessage via the WebSocket onmessage handler, exactly like the bridge does, and
 * checks the response that goes back over the socket (which the bridge hands to the MCP tools).
 * Also checks the MCP tool schema still exposes the tools the Djinni flow uses.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const ext = path.join(root, "extension");
const read = (p) => fs.readFileSync(path.join(ext, p), "utf8");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "djinni-vacancy.html"), "utf8");
const URL_ = "https://djinni.co/jobs/854193-senior-full-stack-tech-lead-ai-native/";

function loadContent(html, url) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const w = dom.window;
  let listener = null;
  w.chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: (m, cb) => cb && cb({}) },
    storage: { local: { get: (k, cb) => { const r = {}; return cb ? cb(r) : Promise.resolve(r); } } }
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
  return { w, dispatch: (msg) => new Promise((res) => listener(msg, {}, res)) };
}

// Boot background.js in a vm; tabs.sendMessage is routed into the jsdom content script.
async function loadBackground(page, tabUrl) {
  const sent = [];
  const sockets = [];
  class FakeWS {
    constructor() { this.readyState = 1; sockets.push(this); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  FakeWS.OPEN = 1;
  const noop = { addListener() {}, removeListener() {} };
  const chrome = {
    alarms: { create() {}, onAlarm: noop },
    runtime: { onMessage: noop, sendMessage: () => Promise.resolve() },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onActivated: noop, onUpdated: noop, onRemoved: noop,
      query: async () => [{ id: 1, windowId: 1, url: tabUrl, title: "djinni" }],
      sendMessage: (tabId, msg, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        if (msg.action === "PING") return cb({ pong: true });
        page.dispatch(msg).then(cb);
      }
    }
  };
  const ctx = vm.createContext({
    chrome, WebSocket: FakeWS, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, json: async () => ({}) }), AbortController, importScripts: (p) => vm.runInContext(read(p.replace("../", "")), ctx), URL
  });
  vm.runInContext(read("background/background.js"), ctx);
  for (let i = 0; i < 100 && !sockets.length; i++) await new Promise((r) => setTimeout(r, 10));
  const ws = sockets[0];
  return async (command, payload = {}) => {
    const before = sent.length;
    ws.onmessage({ data: JSON.stringify({ command, requestId: "r" + before, payload }) });
    for (let i = 0; i < 100 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(sent.length > before, `no bridge response for ${command}`);
    const r = sent[sent.length - 1].response;
    assert.ok(!r.error, `${command} error: ${r.error}`);
    return r.data;
  };
}

console.log("▶ Testing Djinni wiring: bridge command -> background.js -> content.js...");

(async () => {
  // Real saved page: form exists in the DOM with style="display:none" until the opener is clicked.
  const page = loadContent(FIXTURE, URL_);
  const call = await loadBackground(page, URL_);

  let form = await call("GET_ACTIVE_FORM");
  assert.strictEqual(form.formClosed, true, "real page: hidden #apply_form must report formClosed");
  assert.strictEqual(form.openerLabel, "Відгукнутися на вакансію");
  assert.strictEqual(form.platform, "Djinni");
  console.log("✔ GET_ACTIVE_FORM keeps formClosed/openerLabel through background.js");

  const click = await call("CLICK_BUTTON", { text: "Відгукнутися на вакансію" });
  assert.strictEqual(click.success, true, JSON.stringify(click));
  const denied = await call("CLICK_BUTTON", { text: "Надіслати відгук" });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.denied, true);
  console.log("✔ CLICK_BUTTON: opener allowed, 'Надіслати відгук' denied through background.js");

  // Simulate the site's own JS revealing the form (the fixture has no page scripts).
  page.w.document.getElementById("apply_form").style.display = "block";
  form = await call("GET_ACTIVE_FORM");
  assert.strictEqual(form.formClosed, false, JSON.stringify(form));
  assert.ok(form.fields.find((f) => f.fieldId === "djinni_message"));
  assert.strictEqual(form.submitDenied, true);
  console.log("✔ GET_ACTIVE_FORM returns fields (djinni_message) once the form is visible");

  const msg = "Мене зацікавила ця роль: я пишу fullstack TypeScript та працюю з AI-агентами щодня.";
  const fill = await call("FILL_FORM", { answers: { djinni_message: msg } });
  assert.deepStrictEqual(Array.from(fill.failed), []);
  assert.strictEqual(page.w.document.getElementById("message").value, msg, "message textarea must hold the value");
  assert.strictEqual(fill.aiFilledCount, 1);
  console.log("✔ FILL_FORM (INJECT_AI_ANSWERS) reaches fillDjinniForm and sets the textarea");

  // Submission status: the whole object (alreadyApplied) must survive background.js.
  const applied = loadContent(`<body><main><h1>x</h1><div>Ви вже відгукнулись на цю вакансію. Відкрити діалог →</div></main></body>`, URL_);
  const status = await (await loadBackground(applied, URL_))("GET_SUBMISSION_STATUS");
  assert.strictEqual(status.isSubmitted, true, JSON.stringify(status));
  assert.strictEqual(status.alreadyApplied, true);
  console.log("✔ GET_SUBMISSION_STATUS keeps alreadyApplied through background.js");

  // List page
  const list = loadContent(`<body><main><h1>Вакансії</h1></main></body>`, "https://djinni.co/jobs/?primary_keyword=js");
  const lf = await (await loadBackground(list, "https://djinni.co/jobs/?primary_keyword=js"))("GET_ACTIVE_FORM");
  assert.strictEqual(lf.notAVacancyPage, true);
  console.log("✔ notAVacancyPage survives background.js");

  // MCP schema: tools exist and server forwards click_button text / answers unchanged.
  const mcp = fs.readFileSync(path.join(root, "server", "mcp-server.js"), "utf8");
  for (const t of ["get_active_job_form", "fill_job_form", "click_button", "get_submission_status", "get_form_state"]) {
    assert.ok(mcp.includes(`name: "${t}"`), `MCP tool ${t} missing`);
  }
  console.log("✔ Djinni wiring tests passed!");
})().catch((e) => { console.error(e); process.exit(1); });
