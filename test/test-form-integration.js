const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// Runs the REAL content.js + form-helpers.js inside jsdom and talks to it with the same messages the
// background script sends, so scoping, file-input choice, option groups, form state, settle/refill and
// submission detection are tested end to end (not as isolated helpers).
const ext = path.join(__dirname, "..", "extension");
const read = (p) => fs.readFileSync(path.join(ext, p), "utf8");

function load(html, url = "https://example.com/apply") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const w = dom.window;
  let listener = null;
  w.chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: (m, cb) => cb && cb({}) },
    storage: {
      local: {
        // A stored resume so attachResumeFile works; callback and promise styles are both used by content.js.
        get: (k, cb) => {
          const res = { resumeFile: { base64: "eA==", fileName: "resume.pdf", mimeType: "application/pdf" } };
          return cb ? cb(res) : Promise.resolve(res);
        }
      }
    }
  };
  // jsdom lacks innerText and CSS.escape.
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    set(v) { this.textContent = v; }
  });
  // jsdom has no DataTransfer and a read-only input.files: minimal stand-ins so attaching a file is observable.
  Object.defineProperty(w.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() { return this.__files || { length: 0 }; },
    set(v) { this.__files = v; }
  });
  w.DataTransfer = class { constructor() { this._f = []; this.items = { add: (f) => this._f.push(f) }; } get files() { return this._f; } };
  w.CSS = w.CSS || {};
  w.CSS.escape = w.CSS.escape || ((s) => String(s).replace(/[^\w-]/g, "\\$&"));
  w.eval(read("shared/default-profile.js"));
  w.eval(read("content/form-helpers.js"));
  w.eval(read("content/content.js"));
  const send = (msg) => new Promise((resolve) => { listener(msg, {}, resolve); });
  return { w, document: w.document, send, close: () => w.close() };
}

(async () => {
  console.log("▶ Testing form scoping, file inputs, option groups, form state, settle/refill, submission...");

  // 1) Only the application form is scanned: login form in the header, footer form and country search are noise.
  {
    const p = load(`<body>
      <header><form action="/login"><input type="email" aria-label="Email address without domain" id="full_email"><input type="password" name="pw"><button>Log in</button></form></header>
      <main><form>
        <label for="fn">First name*</label><input id="fn" name="first_name">
        <label for="em">Email*</label><input id="em" type="email" name="email">
        <div class="iti__dropdown-content"><input id="iti-0__search-input" type="search" placeholder="Search"></div>
        <label for="cv">Resume/CV</label><input id="cv" type="file" accept=".pdf,.doc,.docx">
        <button type="submit">Submit application</button>
      </form></main>
      <footer><form><input aria-label="Email address without domain" name="footer_email"><button>Log in</button></form></footer>
    </body>`);
    const { fields } = await p.send({ action: "GET_FORM_STATE", maxValueLength: 50, includeEmpty: true });
    const labels = fields.map((f) => f.label);
    assert(labels.includes("First name") && labels.includes("Email"), `application fields present, got ${JSON.stringify(labels)}`);
    assert(!labels.some((l) => /without domain|search/i.test(l)), `noise must be excluded, got ${JSON.stringify(labels)}`);
    assert.strictEqual(fields.find((f) => f.label === "First name").required, false); // no required attr in this markup
    p.close();
  }

  // 1b) A page with NO application form but an embedded video player (video.js caption settings) and a
  //     "set alert" checkbox: the player's Color/Opacity/Font selects must not show up as form fields.
  {
    const p = load(`<body><main><h1>Senior Software Developer</h1>
      <label><input type="checkbox" name="alert"> Set alert for similar jobs</label></main>
      <div class="video-js vjs-big-play-centered"><div class="vjs-text-track-settings">
        <label>Color</label><select class="vjs-color" id="vjs_select_671"><option>White</option><option>Black</option></select>
        <label>Font Family</label><select id="vjs_select_755"><option>Casual</option><option>Script</option></select>
      </div></div></body>`);
    const { fields } = await p.send({ action: "GET_FORM_STATE", maxValueLength: 50, includeEmpty: true });
    const labels = fields.map((f) => f.label);
    assert(!labels.some((l) => /^(color|font family|opacity)$/i.test(l)), `video player settings must be excluded, got ${JSON.stringify(labels)}`);
    p.close();
  }

  // 2) File inputs: "Photo" never becomes the resume; a generic "Attach" is judged by its surrounding question.
  {
    const p = load(`<body><form>
      <div><label for="ph">Photo</label><input id="ph" type="file" accept="image/jpeg,image/png"></div>
      <div><label for="rs">Resume</label><input id="rs" type="file" accept=".pdf,.doc,.docx"></div>
      <div><h4>Resume/CV</h4><button type="button">Attach</button><input id="at" type="file"></div>
      <div><label for="vd">Upload video</label><input id="vd" type="file" accept="video/*"></div>
      <input name="a"><input name="b"><button type="submit">Apply</button>
    </form></body>`);
    const fields = await p.send({ action: "SCAN_FIELDS" });
    const byId = Object.fromEntries(fields.filter((f) => f.type === "file").map((f) => [f.id, f.classification]));
    assert.strictEqual(byId.ph.key, "otherFile", "photo input must not be the resume");
    assert.strictEqual(byId.vd.key, "otherFile", "video input must not be the resume");
    assert.strictEqual(byId.rs.key, "resumeFile");
    assert.strictEqual(byId.rs.fileClass.passed, true);
    assert.strictEqual(byId.at.key, "resumeFile", "generic Attach under a 'Resume/CV' heading is a resume input");
    p.close();

    // Only a photo input on the page: autofill attaches nothing and reports why.
    const q = load(`<body><form><label for="ph">Photo</label><input id="ph" type="file" accept="image/*">
      <label for="n">First name</label><input id="n" name="first_name"><label for="e">Email</label><input id="e" name="email"><button type="submit">Apply</button></form></body>`);
    await q.send({ action: "AUTOFILL_STATIC", candidateData: { personal: { firstName: "Dmytro", email: "d@example.com" } } });
    assert.strictEqual(q.document.getElementById("ph").files.length, 0, "no file attached to the photo input");
    assert.strictEqual(q.document.getElementById("n").value, "Dmytro");
    q.close();
  }

  // 3) Option labels and groups: one checkbox-group, readable radio options, fill by option text (commas inside labels).
  {
    const p = load(`<body><form>
      <fieldset><legend>In my previous roles I successfully...</legend>
        <label><input type="checkbox" name="exp" value="on"> Led a fully remote, distributed engineering team</label>
        <label><input type="checkbox" name="exp" value="on"> Set the technical direction</label>
        <div><input type="checkbox" id="c3" name="exp" value="on"><label for="c3">Kept writing code</label></div>
      </fieldset>
      <fieldset><legend>I like to be interviewed by</legend>
        <div><input type="radio" id="r1" name="by" value="on"><span>an AI</span></div>
        <div><input type="radio" id="r2" name="by" value="on"><span>real people</span></div>
      </fieldset>
      <input name="x"><button type="submit">Submit</button>
    </form></body>`);
    const fields = await p.send({ action: "SCAN_FIELDS" });
    const cb = fields.find((f) => f.type === "checkbox-group");
    assert(cb, "checkboxes sharing a fieldset become one checkbox-group");
    assert.strictEqual(JSON.stringify(cb.options.map((o) => o.label)), JSON.stringify(["Led a fully remote, distributed engineering team", "Set the technical direction", "Kept writing code"]));
    assert.strictEqual(fields.filter((f) => f.type === "checkbox-group").length, 1);
    const radio = fields.find((f) => f.type === "radio-group");
    assert.strictEqual(JSON.stringify(radio.options.map((o) => o.label)), JSON.stringify(["an AI", "real people"]), "radio options are not on");

    const res = await p.send({
      action: "INJECT_AI_ANSWERS",
      answers: {
        [cb.label]: "Led a fully remote, distributed engineering team\nKept writing code",
        [radio.label]: "real people"
      }
    });
    assert.strictEqual(res.aiFilledCount, 2, JSON.stringify(res));
    const state = (await p.send({ action: "GET_FORM_STATE", maxValueLength: 200, includeEmpty: true })).fields;
    assert.strictEqual(state.find((f) => f.type === "checkbox-group").value, "Led a fully remote, distributed engineering team, Kept writing code");
    assert.strictEqual(state.find((f) => f.type === "radio-group").value, "real people");
    assert.strictEqual(p.document.getElementById("c3").checked, true);
    assert.strictEqual(p.document.querySelectorAll("input[name=exp]:checked").length, 2);
    p.close();
  }

  // 4) Settle + refill: wait while the page "parses the resume", then restore a field the page wiped.
  {
    const p = load(`<body><div id="busy">Parsing your resume. Autofilling key fields...</div><form>
      <label for="n">First name</label><input id="n" name="first_name">
      <label for="e">Email</label><input id="e" type="email" name="email">
      <label for="p">Phone</label><input id="p" type="tel" name="phone">
      <button type="submit">Submit</button></form></body>`);
    const w = p.w;
    w.setTimeout(() => p.document.getElementById("busy").remove(), 600);
    // Simulate Ashby wiping the email shortly after it was filled (once).
    let wiped = false;
    p.document.getElementById("e").addEventListener("input", () => {
      if (wiped || !p.document.getElementById("e").value) return;
      wiped = true;
      w.setTimeout(() => { p.document.getElementById("e").value = ""; }, 200);
    });
    const t0 = Date.now();
    const report = await p.send({ action: "AUTOFILL_STATIC", candidateData: { personal: { firstName: "Dmytro", email: "d@example.com", phone: "+380971234567" } } });
    assert(Date.now() - t0 >= 500, `must wait for the parsing state to clear (took ${Date.now() - t0} ms)`);
    assert.strictEqual(p.document.getElementById("n").value, "Dmytro");
    assert.strictEqual(p.document.getElementById("e").value, "d@example.com", "wiped field is restored");
    assert(report.refilled.some((l) => /email/i.test(l)), `refilled must list Email, got ${JSON.stringify(report.refilled)}`);
    assert(Array.isArray(report.filled) && report.filled.length >= 2);
    p.close();
  }

  // 6) Resume attaches to EVERY confidently identified resume input (Ashby: "Autofill from resume" dropzone AND the
  //    required "Resume" field), never to Photo/Video.
  {
    const p = load(`<body><form>
      <div><label for="az">Autofill from resume</label><input id="az" type="file"></div>
      <label for="n">Name</label><input id="n" name="name">
      <label for="e">Email</label><input id="e" type="email" name="email">
      <div><label for="rs">Resume</label><input id="rs" type="file" required></div>
      <div><label for="ph">Photo</label><input id="ph" type="file" accept="image/*"></div>
      <button type="submit">Submit Application</button></form></body>`);
    await p.send({ action: "AUTOFILL_STATIC", candidateData: { personal: { firstName: "Dmytro", lastName: "Bilukha", email: "d@example.com" } } });
    const len = (id) => p.document.getElementById(id).files.length;
    assert.strictEqual(len("az"), 1, "autofill dropzone gets the resume");
    assert.strictEqual(len("rs"), 1, "the required Resume field also gets the resume");
    assert.strictEqual(len("ph"), 0, "photo input stays empty");
    const state = (await p.send({ action: "GET_FORM_STATE", maxValueLength: 60, includeEmpty: true })).fields;
    assert.strictEqual(state.find((f) => f.label === "Resume").filled, true);
    p.close();
  }

  // 5) Submission detection: URL patterns (Teamtailor /connect/dashboard, Recruitee /applied) and page text.
  {
    const neutral = load("<body><h1>Senior Engineer</h1><form><input name='a'><input name='b'><input name='c'></form></body>", "https://x.example/jobs/1/apply");
    assert.strictEqual((await neutral.send({ action: "GET_SUBMISSION_STATUS" })).isSubmitted, false);
    const byUrl = await neutral.send({ action: "GET_SUBMISSION_STATUS", tabUrl: "https://x.teamtailor.com/connect/dashboard" });
    assert.strictEqual(byUrl.isSubmitted, true);
    assert.strictEqual(byUrl.matchedBy, "url");
    for (const u of ["https://x.recruitee.com/o/pm/applied", "https://x.applytojob.com/apply/confirm/AbC?source=LILI", "https://x.com/jobs/thank-you"]) {
      assert.strictEqual((await neutral.send({ action: "GET_SUBMISSION_STATUS", tabUrl: u })).matchedBy, "url", u);
    }
    assert.strictEqual((await neutral.send({ action: "GET_SUBMISSION_STATUS", tabUrl: "https://x.com/success-stories" })).isSubmitted, false, "no false positive on /success-stories");
    neutral.close();

    const text = load("<body><h1>Frontend Engineer</h1><p>Success</p><p>Your application was successfully submitted. We'll contact you if there are next steps.</p></body>");
    const byText = await text.send({ action: "GET_SUBMISSION_STATUS" });
    assert.strictEqual(byText.isSubmitted, true);
    assert.strictEqual(byText.matchedBy, "text");
    text.close();
  }

  console.log("✔ Form integration tests passed!");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
