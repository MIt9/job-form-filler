const assert = require("assert");
const fs = require("fs");
const path = require("path");

// The content-script file list must be identical in the manifest and in both dynamic-injection fallbacks,
// helpers must load before content.js, and the fallback needs host access to inject anywhere.
const ext = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
console.log("▶ Testing manifest and content-script injection lists...");

const js = manifest.content_scripts[0].js;
assert.deepStrictEqual(js, ["shared/default-profile.js", "content/form-helpers.js", "content/content.js"]);
for (const f of js) assert(fs.existsSync(path.join(ext, f)), `${f} exists`);
assert(manifest.host_permissions.includes("<all_urls>"), "fallback injection needs <all_urls> host access");
assert(manifest.permissions.includes("scripting") && manifest.permissions.includes("tabs"));

const list = JSON.stringify(js).replace(/"/g, '"');
for (const file of ["background/background.js", "popup/popup.js"]) {
  const src = fs.readFileSync(path.join(ext, file), "utf8");
  const m = src.match(/files: (\[[^\]]*content\/content\.js"\])/);
  assert(m, `${file} injects content scripts`);
  assert.strictEqual(JSON.stringify(JSON.parse(m[1])), list, `${file} injection list matches the manifest`);
}
console.log("✔ Manifest tests passed!");
