/**
 * Bot-challenge detection in get_job_posting.
 * Fixture test/fixtures/cloudflare-challenge.html is the REAL 403 interstitial returned by
 * https://career.proxify.io/apply to plain HTTP (fetched 2026-11-05). No live network calls.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getJobPosting, isBotChallengeHtml } = require("../server/job-posting");

const CHALLENGE = fs.readFileSync(path.join(__dirname, "fixtures/cloudflare-challenge.html"), "utf8");
// A normal page that merely loads Cloudflare scripts (seen on wellfound.com) must not be flagged.
const NORMAL = '<html><head><title>Find Startup Jobs | Wellfound</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><main>Senior QA Engineer</main></body></html>';

const respond = (status, body, url) => Promise.resolve({
  ok: status >= 200 && status < 300, status, statusText: String(status), url,
  headers: { get: () => null }, text: async () => body
});

console.log("▶ Testing bot-challenge detection...");

(async () => {
  assert.strictEqual(isBotChallengeHtml(CHALLENGE), true);
  assert.strictEqual(isBotChallengeHtml("<title>Attention Required! | Cloudflare</title>"), true);
  assert.strictEqual(isBotChallengeHtml(NORMAL), false);
  assert.strictEqual(isBotChallengeHtml(""), false);
  console.log("✔ isBotChallengeHtml: challenge pages yes, pages with Cloudflare scripts no");

  // 403 challenge on a generic URL (goes through resolveApplyUrl, html preloaded).
  await assert.rejects(
    getJobPosting("https://career.example.com/apply", { fetchImpl: (u) => respond(403, CHALLENGE, String(u)) }),
    (err) => err.code === "BOT_CHALLENGE" && /open_job_url/.test(err.message)
  );
  // Redirect chain ending on a challenge (Working Nomads /job/go/ -> employer).
  await assert.rejects(
    getJobPosting("https://jobs.example.com/job/go/1/", {
      fetchImpl: (u) => respond(200, CHALLENGE, "https://career.example.com/apply")
    }),
    (err) => err.code === "BOT_CHALLENGE" && err.message.includes("career.example.com")
  );
  console.log("✔ getJobPosting: challenge -> BOT_CHALLENGE error with open_job_url hint");

  const ok = await getJobPosting("https://jobs.example.com/x", { fetchImpl: (u) => respond(200, NORMAL, String(u)) });
  assert.strictEqual(ok.source, "generic");
  assert.ok(ok.descriptionText.includes("Senior QA Engineer"));
  console.log("✔ normal page with Cloudflare scripts still parsed");

  await assert.rejects(
    getJobPosting("https://jobs.example.com/x", { fetchImpl: (u) => respond(500, "oops", String(u)) }),
    (err) => err.code === undefined
  );
  console.log("✔ plain HTTP errors are not reported as bot challenge");

  console.log("✔ All bot-challenge tests passed!");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
