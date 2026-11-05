/**
 * Himalayas job-posting adapter tests.
 * Fixture test/fixtures/himalayas-job.json is the REAL response of
 * GET https://himalayas.app/jobs/api/companies/rockstar/jobs/qa-engineer (fetched 2026-11-05).
 * No live network calls.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getJobPosting, detectAdapter, validateUrl, extractRequirements } = require("../server/job-posting");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/himalayas-job.json"), "utf8");
const JOB_URL = "https://himalayas.app/companies/rockstar/jobs/qa-engineer?utm_source=api";
const API_URL = "https://himalayas.app/jobs/api/companies/rockstar/jobs/qa-engineer";

function mockFetch(routes, calls = []) {
  return (url) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u];
    if (!r) return Promise.reject(new Error(`Unexpected URL in mock: ${u}`));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      url: u,
      json: async () => JSON.parse(r.body),
      text: async () => r.body
    });
  };
}

console.log("▶ Testing Himalayas job-posting adapter...");

(async () => {
  assert.strictEqual(detectAdapter(validateUrl(JOB_URL)), "himalayas");
  assert.strictEqual(detectAdapter(validateUrl("https://himalayas.evil.example/companies/a/jobs/b")), "generic");
  console.log("✔ detectAdapter: himalayas.app only");

  {
    const calls = [];
    const p = await getJobPosting(JOB_URL, { fetchImpl: mockFetch({ [API_URL]: { status: 200, body: FIXTURE } }, calls) });
    // Only the API is requested: the Cloudflare-protected job page is never fetched.
    assert.deepStrictEqual(calls, [API_URL]);
    assert.strictEqual(p.source, "himalayas");
    assert.strictEqual(p.title, "QA Engineer");
    assert.strictEqual(p.company, "Rockstar");
    assert.strictEqual(p.url, "https://himalayas.app/companies/rockstar/jobs/qa-engineer");
    assert.strictEqual(p.location, "Ukraine");
    assert.deepStrictEqual(p.locationRestrictions, ["Ukraine"]);
    assert.strictEqual(p.compensation, "80000 USD annual");
    assert.strictEqual(p.remote, null);
    assert.ok(p.descriptionText.length > 200, "description converted to text");
    assert.ok(!/<p>|<br/.test(p.descriptionText), "no HTML left in description");
    assert.match(p.postedAt, /^\d{4}-\d\d-\d\dT/);
    console.log("✔ getJobPosting: real API fixture normalized, job page not fetched");

    const s = await getJobPosting(JOB_URL, { summary: true, fetchImpl: mockFetch({ [API_URL]: { status: 200, body: FIXTURE } }) });
    assert.strictEqual(s.source, "himalayas");
    assert.strictEqual(s.compensation, "80000 USD annual");
    console.log("✔ getJobPosting summary");
  }

  {
    const job = JSON.parse(FIXTURE);
    job.job.locationRestrictions = Array.from({ length: 150 }, (_, i) => `C${i}`);
    job.job.minSalary = 3000; job.job.maxSalary = 4000;
    const p = await getJobPosting(JOB_URL, { fetchImpl: mockFetch({ [API_URL]: { status: 200, body: JSON.stringify(job) } }) });
    assert.strictEqual(p.location, "150 countries");
    assert.strictEqual(p.locationRestrictions.length, 150);
    assert.strictEqual(p.compensation, "3000–4000 USD annual");
    console.log("✔ long location list summarized, full list kept; salary range");
  }

  for (const [status, re] of [[410, /closed/], [404, /not found/], [503, /HTTP 503/]]) {
    await assert.rejects(
      getJobPosting(JOB_URL, { fetchImpl: mockFetch({ [API_URL]: { status, body: "{}" } }) }),
      re
    );
  }
  await assert.rejects(
    getJobPosting(JOB_URL, { fetchImpl: mockFetch({ [API_URL]: { status: 200, body: "{}" } }) }),
    /returned no job/
  );
  await assert.rejects(getJobPosting("https://himalayas.app/jobs/qa", { fetchImpl: mockFetch({}) }), /Invalid Himalayas URL/);
  console.log("✔ errors: closed, not found, HTTP error, empty body, bad URL");

  {
    // Real Himalayas/ATS descriptions use typographic apostrophes in headings.
    const text = "What you’ll do\nShip tests\nWhat you’ll bring\n• 5+ years QA\nWhat we offer\nPerks";
    assert.strictEqual(extractRequirements(text), "What you’ll bring\n• 5+ years QA");
    assert.strictEqual(extractRequirements(text.replace(/’/g, "'")), "What you'll bring\n• 5+ years QA");
    console.log("✔ extractRequirements: typographic and plain apostrophes");
  }

  console.log("✔ All Himalayas job-posting adapter tests passed!");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
