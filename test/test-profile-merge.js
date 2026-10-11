const assert = require("assert");
const { mergeProfile } = require("../extension/shared/default-profile.js");

console.log("▶ Testing mergeProfile (form learning + MCP update_candidate_profile)...");

const current = { personal: { firstName: "Jane", email: "" }, links: {}, work: {}, legal: {}, eeo: {}, profiles: {} };

// Empty slots are filled, existing values are kept and reported as conflicts.
const r = mergeProfile(current, {
  personal: { firstName: "Janet", email: " jane@example.com ", city: "Kyiv" },
  legal: { requiresSponsorship: false }
});
assert.deepStrictEqual(r.changed.sort(), ["legal.requiresSponsorship", "personal.city", "personal.email"]);
assert.deepStrictEqual(r.conflicts, [{ path: "personal.firstName", current: "Jane", proposed: "Janet" }]);
assert.strictEqual(r.data.personal.email, "jane@example.com", "Values are trimmed");
assert.strictEqual(r.data.legal.requiresSponsorship, "No", "Booleans become Yes/No");
assert.strictEqual(current.personal.city, undefined, "Input profile is not mutated");

// overwrite replaces existing values.
assert.strictEqual(mergeProfile(current, { personal: { firstName: "Janet" } }, true).data.personal.firstName, "Janet");

// Only editor paths and role variants are accepted; anything else is ignored, not stored.
const bad = mergeProfile(current, {
  personal: { ssn: "123", email: { nested: "x" } },
  secrets: { token: "t" },
  profiles: { "frontend-dev": { title: "FE", summary: "Builds UIs", extra: "x" } },
  __proto__: { polluted: "yes" }
});
assert.deepStrictEqual(bad.changed.sort(), ["profiles.frontend-dev.summary", "profiles.frontend-dev.title"]);
assert(bad.ignored.includes("personal.ssn") && bad.ignored.includes("secrets.token") && bad.ignored.includes("profiles.frontend-dev.extra"));

const proto = mergeProfile(current, JSON.parse('{"profiles": {"__proto__": {"title": "x"}}, "__proto__": {"polluted": "yes"}}'));
assert.strictEqual({}.title, undefined, "No prototype pollution via profiles.__proto__");
assert.strictEqual({}.polluted, undefined, "No prototype pollution via __proto__");
assert.deepStrictEqual(proto.changed, []);

// Translations: only translatable fields, only supported form languages.
const loc = mergeProfile(current, {
  localized: {
    uk: { personal: { firstName: "Дмитро", email: "x@y.z" }, work: { noticePeriod: "2 тижні" } },
    xx: { personal: { firstName: "?" } }
  }
});
assert.deepStrictEqual(loc.changed.sort(), ["localized.uk.personal.firstName", "localized.uk.work.noticePeriod"]);
assert(loc.ignored.includes("localized.uk.personal.email"), "Email is not translatable");
assert(loc.ignored.includes("localized.xx.personal.firstName"), "Unknown language is rejected");

// Non-object patches are a no-op, not a crash (patch comes from an AI agent).
assert.deepStrictEqual(mergeProfile(current, "oops").changed, []);
assert.deepStrictEqual(mergeProfile(current, ["x"]).changed, []);

console.log("✔ mergeProfile tests passed!");
