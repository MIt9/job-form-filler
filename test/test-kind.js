const assert = require("assert");
const { classifyQuestionKind } = require("../server/human-questions.js");

console.log("▶ kind classification");
assert.strictEqual(classifyQuestionKind("Скільки років досвіду з PHP?"), "factual");
assert.strictEqual(classifyQuestionKind("Розкажіть про випадок, коли ви помилились"), "behavioral");
assert.strictEqual(classifyQuestionKind("Why us?"), "motivational");
assert.strictEqual(classifyQuestionKind("Are you authorized to work in the EU?"), "authorization");
assert.strictEqual(classifyQuestionKind("Gender"), "eeo");
console.log("✔ kind tests passed");