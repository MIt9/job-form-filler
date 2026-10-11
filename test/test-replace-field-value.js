const assert = require("assert");

// Fake text field: `select()` marks the whole value selected; the fake execCommand mimics the
// real browser — "delete" removes the selection, "insertText" REPLACES a selection but otherwise
// APPENDS at the cursor (this append behaviour is the original concatenation bug).
class FakeField {
  constructor(tagName, value) {
    this.tagName = tagName;
    this.type = tagName === "TEXTAREA" ? "textarea" : "text";
    this._value = value;
    this.selected = false;
  }
  get value() { return this._value; }
  set value(v) { this._value = v; this.selected = false; }
  focus() {}
  select() { this.selected = true; }
  dispatchEvent() { return true; }
  setAttribute() {}
  getAttribute() { return null; }
}

let active = null;
global.window = { location: { hostname: "example.com" } };
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
global.document = {
  execCommand(cmd, _ui, text) {
    if (!active) return false;
    if (cmd === "delete") { if (active.selected) { active._value = ""; active.selected = false; } return true; }
    if (cmd === "insertText") {
      active._value = active.selected ? String(text) : active._value + String(text);
      active.selected = false;
      return true;
    }
    return false;
  },
};

const { replaceFieldValue } = require("../extension/content/content.js");
assert.strictEqual(typeof replaceFieldValue, "function", "replaceFieldValue must be exported for tests");

console.log("▶ Testing replaceFieldValue (fill_job_form must replace, not concatenate)...");

for (const tag of ["TEXTAREA", "INPUT"]) {
  const el = new FakeField(tag, "Old answer");
  active = el;
  replaceFieldValue(el, "New answer");
  assert.strictEqual(el.value, "New answer", `${tag}: pre-filled value must be replaced, got "${el.value}"`);

  // Second fill on the same field must not stack either.
  replaceFieldValue(el, "Newer answer");
  assert.strictEqual(el.value, "Newer answer", `${tag}: repeated fill must not concatenate, got "${el.value}"`);
}

// Empty string clears the field.
const clearable = new FakeField("TEXTAREA", "Text to clear");
active = clearable;
replaceFieldValue(clearable, "");
assert.strictEqual(clearable.value, "", "empty answer must clear the field");

// Works when document.execCommand is unavailable (guarded call, property-setter fallback).
const noExec = new FakeField("INPUT", "Old");
active = noExec;
const realDoc = global.document;
global.document = {};
replaceFieldValue(noExec, "Plain");
global.document = realDoc;
assert.strictEqual(noExec.value, "Plain", "must fall back to the property setter without execCommand");

console.log("✔ replaceFieldValue tests passed!");
