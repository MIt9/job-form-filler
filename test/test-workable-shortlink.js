/**
 * Workable shortlink apply.workable.com/j/{code}: account comes from the 301 Location
 * (real behaviour 2026-11-05: /j/0BD8C06DB3 -> /huggingface/j/0BD8C06DB3). No live network.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getJobPosting } = require("../server/job-posting");

const DATA = fs.readFileSync(path.join(__dirname, "fixtures/workable.json"), "utf8");

function mock(calls, { location }) {
  return (url, opts = {}) => {
    const u = String(url);
    calls.push([u, opts.redirect || "follow"]);
    if (u === "https://apply.workable.com/j/WORK999") {
      return Promise.resolve({ ok: false, status: 301, statusText: "Moved", url: u,
        headers: { get: (h) => (h.toLowerCase() === "location" ? location : null) } });
    }
    if (u === "https://apply.workable.com/api/v2/accounts/acme/jobs/WORK999") {
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", url: u, json: async () => JSON.parse(DATA) });
    }
    return Promise.resolve({ ok: false, status: 404, statusText: "Not Found", url: u, headers: { get: () => null } });
  };
}

console.log("▶ Testing Workable shortlink...");
(async () => {
  {
    const calls = [];
    const p = await getJobPosting("https://apply.workable.com/j/WORK999", { fetchImpl: mock(calls, { location: "https://apply.workable.com/acme/j/WORK999" }) });
    assert.strictEqual(p.source, "workable");
    assert.strictEqual(p.title, "Lead DevOps & Infrastructure Engineer");
    assert.deepStrictEqual(calls, [
      ["https://apply.workable.com/j/WORK999", "manual"],
      ["https://apply.workable.com/api/v2/accounts/acme/jobs/WORK999", "follow"]
    ]);
    console.log("✔ shortlink: account read from redirect, v2 API used");
  }
  {
    const calls = [];
    await getJobPosting("https://apply.workable.com/j/WORK999", { fetchImpl: mock(calls, { location: "/acme/j/WORK999" }) });
    assert.strictEqual(calls[1][0], "https://apply.workable.com/api/v2/accounts/acme/jobs/WORK999");
    console.log("✔ shortlink: relative Location");
  }
  {
    const calls = [];
    await assert.rejects(
      getJobPosting("https://apply.workable.com/j/WORK999", { fetchImpl: mock(calls, { location: null }) }),
      /Workable API error: HTTP 404/
    );
    assert.strictEqual(calls[1][0], "https://apply.workable.com/api/v1/widget/jobs/WORK999");
    console.log("✔ no redirect: falls back to widget endpoint and reports its error");
  }
  console.log("✔ All Workable shortlink tests passed!");
})().catch((e) => { console.error(e); process.exit(1); });
