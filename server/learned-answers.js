const fs = require("fs");
const path = require("path");
const { DEFAULT_RESUME_REPO_PATH, DATA_DIR } = require("./profile-loader");

// Learned answers contain personal data: keep them next to the user's resume repo, or in
// ~/.job-form-filler — never inside this (publishable) project folder.
const DEFAULT_LEARNED_FILE = DEFAULT_RESUME_REPO_PATH
  ? path.join(DEFAULT_RESUME_REPO_PATH, "resume", "learned-form-answers.json")
  : path.join(DATA_DIR, "learned-answers.json");

/**
 * Loads learned custom question answers
 */
function getLearnedAnswers(filePath = DEFAULT_LEARNED_FILE) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8") || "{}");
    }
  } catch (err) {
    console.error("[LearnedAnswers] Error reading answers:", err.message);
  }
  return {};
}

/**
 * Replaces the stored answers. The popup always sends its full map, so replacing (not merging)
 * is what makes its delete / "clear all" actions actually stick.
 */
function saveLearnedAnswers(answers = {}, filePath = DEFAULT_LEARNED_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(answers, null, 2), "utf-8");
  return {
    success: true,
    totalAnswers: Object.keys(answers).length,
    savedAnswers: answers
  };
}

module.exports = {
  getLearnedAnswers,
  saveLearnedAnswers
};
