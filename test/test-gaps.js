const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { classifyQuestionKind, isHumanRequiredQuestion } = require("../server/human-questions.js");

// Covers: question kind, DOU/Greenhouse submission URLs, stable fieldIds, value leakage, char-limit counters.
const ext = path.join(__dirname, "..", "extension");
const read = (p) => fs.readFileSync(path.join(ext, p), "utf8");

function load(html, url = "https://example.com/apply") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const w = dom.window;
  let listener = null;
  w.chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: (m, cb) => cb && cb({}) },
    storage: { local: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})) } }
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

(async () => {
  console.log("▶ Testing kind, submission URLs, stable ids, value leakage, char counters...");

  // A1) kind / humanRequired
  assert.strictEqual(classifyQuestionKind("Скільки років досвіду з PHP?"), "factual");
  assert.strictEqual(classifyQuestionKind("Years of experience with REST APIs"), "factual");
  assert.strictEqual(classifyQuestionKind("Розкажіть про випадок, коли ви помилились"), "behavioral");
  assert.strictEqual(classifyQuestionKind("Why this company?"), "motivational");
  assert.strictEqual(classifyQuestionKind("Are you authorized to work in the US?"), "authorization");
  assert.strictEqual(classifyQuestionKind("Veteran status"), "eeo");
  assert(isHumanRequiredQuestion({ label: "Tell us about a time you failed" }));
  console.log("✔ question kinds");

  // A2) submission status by URL
  {
    const p = load("<body><p>hello</p></body>");
    const st = (tabUrl) => p.send({ action: "GET_SUBMISSION_STATUS", tabUrl });
    for (const u of ["https://jobs.dou.ua/companies/x/vacancies/1/?sent", "https://jobs.dou.ua/companies/x/vacancies/1/#replied-123", "https://boards.greenhouse.io/x/jobs/1/confirmation"]) {
      const r = await st(u);
      assert.strictEqual(r.isSubmitted, true, u);
      assert.strictEqual(r.matchedBy, "url", u);
    }
    for (const u of ["https://jobs.dou.ua/companies/x/vacancies/1/", "https://example.com/job?sent"]) {
      assert.strictEqual((await st(u)).isSubmitted, false, u);
    }
    p.close();
    console.log("✔ DOU / Greenhouse submission urls");
  }

  // A3) stable fieldIds
  {
    const page = (extra) => `<body><form>${extra}
      <label for="a">Expected salary</label><input id="a">
      <label for="b">Notice period</label><input id="b">
      <label for="c">Phone backup</label><input id="c"><label for="d">Phone backup</label><input id="d">
    </form></body>`;
    const ids = async (p) => (await p.send({ action: "SCAN_FIELDS" })).map((f) => f.fieldId);
    const p1 = load(page(""));
    const first = await ids(p1);
    assert.strictEqual(JSON.stringify(await ids(p1)), JSON.stringify(first), "two scans give identical ids");
    assert.strictEqual(new Set(first).size, first.length, `ids unique, got ${JSON.stringify(first)}`);
    const p2 = load(page('<label for="z">Zip</label><input id="z">'));
    const withExtra = await ids(p2);
    const missing = first.filter((id) => !withExtra.includes(id));
    assert.strictEqual(missing.length, 0, "ids survive an added field above: " + missing);
    p1.close(); p2.close();
    console.log("✔ stable unique fieldIds");
  }

  // B) no leakage between neighbouring fields
  {
    const p = load(`<body><form>
      <label for="s">Salary expectations</label><input id="s">
      <fieldset><legend>Do you need sponsorship?</legend>
        <input type="radio" id="y" name="sp" value="Yes"><label for="y">Yes</label>
        <input type="radio" id="n" name="sp" value="No"><label for="n">No</label></fieldset>
      <label for="c">Comment</label><textarea id="c"></textarea>
    </form></body>`);
    const fields = await p.send({ action: "SCAN_FIELDS" });
    const by = (re) => fields.find((f) => re.test(f.label));
    const res = await p.send({
      action: "INJECT_AI_ANSWERS",
      answers: { [by(/Salary/).fieldId]: "$3,500/month", [by(/sponsorship/).fieldId]: "No", [by(/Comment/).label]: "Hello" }
    });
    assert.strictEqual(res.aiFilledCount, 3, JSON.stringify(res));
    assert.strictEqual(p.document.getElementById("s").value, "$3,500/month");
    assert.strictEqual(p.document.getElementById("c").value, "Hello");
    assert.strictEqual(p.document.getElementById("n").checked, true);
    assert.strictEqual(p.document.getElementById("y").checked, false);
    p.close();
    console.log("✔ no value leakage");
  }

  // C) char counters + refusal
  {
    const p = load(`<body><form>
      <label for="a">Cover letter</label><textarea id="a"></textarea><span>0/1000</span>
      <div><label for="b">Why you</label><textarea id="b"></textarea><small>Max 500 characters</small></div>
      <div><label for="c">Bio</label><textarea id="c"></textarea><small>300 characters left</small></div>
      <label for="d">Attr wins</label><textarea id="d" maxlength="50"></textarea><span>0/900</span>
    </form></body>`);
    const f = await p.send({ action: "SCAN_FIELDS" });
    const lim = (re) => f.find((x) => re.test(x.label))?.maxLength;
    assert.strictEqual(lim(/Cover/), 1000);
    assert.strictEqual(lim(/Why you/), 500);
    assert.strictEqual(lim(/Bio/), 300);
    assert.strictEqual(lim(/Attr wins/), 50);
    const res = await p.send({ action: "INJECT_AI_ANSWERS", answers: { "Why you": "x".repeat(501) } });
    assert.strictEqual(res.aiFilledCount, 0);
    assert(JSON.stringify(res.failed).includes("exceeds maxLength 500"), JSON.stringify(res));
    assert.strictEqual(p.document.getElementById("b").value, "");
    p.close();
    console.log("✔ char counters and refusal");
  }

  console.log("✔ Gap tests passed!");
})().catch((e) => { console.error(e); process.exit(1); });
