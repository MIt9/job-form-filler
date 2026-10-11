const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { jffPickBestTab } = require("../extension/shared/tab-pick.js");

// Runs the REAL content.js in jsdom (same harness idea as test-form-integration.js) and checks click_button
// safety by spying on actual click handlers, plus tab selection and the combobox neighbour-protection.
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
  console.log("▶ Testing click_button safety, tab selection and combobox neighbour protection...");

  // ---- click_button -------------------------------------------------------------------------
  {
    const p = load(`<body><form>
      <input name="a"><input name="b"><input name="c">
      <button type="button" id="cont">Continue</button>
      <button type="submit" id="sub">Submit application</button>
      <button type="button" id="ua">Надіслати заявку</button>
      <button type="button" id="apply">Apply</button>
      <button type="button" id="applynow">Apply Now</button>
      <button type="button" id="del">Delete</button>
      <button type="button" id="sc">Submit and continue</button>
      <button type="button" id="trick" aria-label="Submit application">Next</button>
      <button type="button" id="dis" disabled>Далі</button>
      <button type="button" id="back">Back</button>
    </form></body>`);
    const clicks = [];
    for (const b of p.document.querySelectorAll("button")) b.addEventListener("click", () => clicks.push(b.id));
    const click = (text) => p.send({ action: "CLICK_BUTTON", text });

    // allowed, exact (case/whitespace-insensitive)
    assert.strictEqual((await click("Continue")).success, true);
    assert.deepStrictEqual(clicks.splice(0), ["cont"]);
    assert.strictEqual((await click("  CONTINUE  ")).success, true);
    assert.deepStrictEqual(clicks.splice(0), ["cont"]);
    assert.strictEqual((await click("Apply Now")).success, true);
    assert.deepStrictEqual(clicks.splice(0), ["applynow"]);

    // refused labels: never clicked
    for (const label of ["Submit application", "Надіслати заявку", "Apply", "Delete", "Submit and continue", "Back", "Send", "Pay", "Finish"]) {
      const r = await click(label);
      assert.strictEqual(r.success, false, `${label} must be refused`);
      assert.strictEqual(r.denied, true, `${label} must report denied`);
      assert(Array.isArray(r.allowed) && r.allowed.includes("continue"), "refusal lists the allowed labels");
    }
    // substrings of allowed labels are NOT allowed
    for (const label of ["app", "now", "start", "save", "con", "e", "cont"]) {
      assert.strictEqual((await click(label)).denied, true, `substring "${label}" must be refused`);
    }
    assert.deepStrictEqual(clicks, [], "no refused request clicked anything");

    // an allowed label on a button whose aria-label says Submit is refused, not clicked
    const trick = await click("Next");
    assert.strictEqual(trick.success, false);
    assert.strictEqual(trick.denied, true);
    assert.deepStrictEqual(clicks, [], "Next with aria-label 'Submit application' must not be clicked");

    // disabled allowed button is not clicked
    const dis = await click("Далі");
    assert.strictEqual(dis.success, false);
    assert.deepStrictEqual(clicks, [], "disabled button not clicked");
    p.close();
  }

  // ---- tab selection ------------------------------------------------------------------------
  {
    const park = { id: 50, windowId: 1, active: true, url: "chrome-extension://abc/park.html?tabId=5" };
    const real = { id: 40, windowId: 1, active: true, url: "https://explore-jobs.ciklum.com/job/1" };
    const other = { id: 60, windowId: 2, active: true, url: "https://explore-jobs.ciklum.com/job/1" };
    const old = { id: 10, windowId: 1, active: false, url: "https://explore-jobs.ciklum.com/job/1" };
    let r = jffPickBestTab([park, real], 1);
    assert.strictEqual(r.tab.id, 40, "extension/park tab is ignored");
    assert.strictEqual(r.count, 1);
    r = jffPickBestTab([real, other, park], 2);
    assert.strictEqual(r.tab.id, 60, "active tab of the last-focused window wins");
    assert.strictEqual(r.count, 2);
    r = jffPickBestTab([old, { ...real, active: false, id: 30 }], 9);
    assert.strictEqual(r.tab.id, 30, "no active tab: highest id (most recent)");
    assert.strictEqual(jffPickBestTab([park], 1).tab, null, "only extension tabs: nothing usable");
    assert.strictEqual(jffPickBestTab([], 1).count, 0);
  }

  // ---- combobox must not corrupt a neighbouring field ------------------------------------------
  {
    const p = load(`<body><form>
      <label for="port">Portfolio link</label>
      <textarea id="port">https://bilukha.dev/</textarea>
      <label for="country">Country</label>
      <input id="country" type="text" role="combobox" aria-controls="country-list" aria-expanded="false">
      <div id="country-list" role="listbox"><div role="option">Ukraine</div><div role="option">United States</div></div>
      <input name="x"><button type="submit">Next</button>
    </form></body>`);
    const textarea = p.document.getElementById("port");
    // Simulate the real failure: the browser inserts typed text into the PREVIOUSLY focused field.
    p.document.execCommand = (cmd, _ui, text) => {
      if (cmd === "insertText") {
        textarea.value += text;
        return true;
      }
      return false;
    };
    textarea.focus();
    await p.send({ action: "INJECT_AI_ANSWERS", answers: { country: "Ukraine" } });
    assert.strictEqual(textarea.value, "https://bilukha.dev/", `neighbour must be restored, got "${textarea.value}"`);
    p.close();
  }

  console.log("✔ click_button, tab selection and combobox protection tests passed!");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
