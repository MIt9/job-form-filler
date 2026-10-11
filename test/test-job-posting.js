const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  getJobPosting,
  resolveApplyUrl,
  extractGeoHints,
  isPrivateHost,
  isAggregatorHost,
  isKnownAtsHost,
  decodeHtmlEntities,
  htmlToPlainText,
  extractRequirements,
  detectAdapter,
  validateUrl
} = require("../server/job-posting");
const { TOOLS } = require("../server/mcp-server");

console.log("▶ Testing Job Posting module, Aggregator Resolver & MCP integration...");

function createMockFetch() {
  const ashbyData = fs.readFileSync(path.join(__dirname, "fixtures/ashby.json"), "utf8");
  const ghData = fs.readFileSync(path.join(__dirname, "fixtures/greenhouse.json"), "utf8");
  const ghEuData = fs.readFileSync(path.join(__dirname, "fixtures/greenhouse-eu.json"), "utf8");
  const leverData = fs.readFileSync(path.join(__dirname, "fixtures/lever.json"), "utf8");
  const workableData = fs.readFileSync(path.join(__dirname, "fixtures/workable.json"), "utf8");
  const genericJsonLd = fs.readFileSync(path.join(__dirname, "fixtures/generic-jsonld.html"), "utf8");
  const genericHtml = fs.readFileSync(path.join(__dirname, "fixtures/generic-html.html"), "utf8");
  const startupJobsHtml = fs.readFileSync(path.join(__dirname, "fixtures/startup-jobs.html"), "utf8");
  const welcometothejungleHtml = fs.readFileSync(path.join(__dirname, "fixtures/welcometothejungle.html"), "utf8");
  const bebeeHtml = fs.readFileSync(path.join(__dirname, "fixtures/bebee.html"), "utf8");
  const unresolvedAggregatorHtml = fs.readFileSync(path.join(__dirname, "fixtures/startup-jobs-unresolved.html"), "utf8");

  return async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // ATS API mocks
    if (urlStr.includes("api.ashbyhq.com/posting-api/job-board/acme")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        json: async () => JSON.parse(ashbyData)
      };
    }
    if (urlStr.includes("boards-api.greenhouse.io/v1/boards/acme-eu/jobs/67890")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        json: async () => JSON.parse(ghEuData)
      };
    }
    if (urlStr.includes("boards-api.greenhouse.io/v1/boards/acme/jobs/12345")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        json: async () => JSON.parse(ghData)
      };
    }
    if (urlStr.includes("api.lever.co/v0/postings/acme/lever-job-456")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        json: async () => JSON.parse(leverData)
      };
    }
    if (urlStr.includes("apply.workable.com/api/v2/accounts/acme/jobs/WORK999")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        json: async () => JSON.parse(workableData)
      };
    }

    // Aggregators & web fixtures
    if (urlStr.includes("startup.jobs/acme/software-engineer")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => startupJobsHtml
      };
    }
    if (urlStr.includes("welcometothejungle.com/en/companies/acme/jobs/backend")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => welcometothejungleHtml
      };
    }
    if (urlStr.includes("bebee.com/job/fullstack-platform-engineer")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => bebeeHtml
      };
    }
    if (urlStr.includes("startup.jobs/solo/growth-lead-unresolved")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => unresolvedAggregatorHtml
      };
    }

    // Generic pages
    if (urlStr.includes("example.com/jobs/pm-jsonld")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => genericJsonLd
      };
    }
    if (urlStr.includes("careers.fallbackcorp.com/security-engineer")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => genericHtml
      };
    }

    // Redirect tracker to Ashby
    if (urlStr.includes("tracker.com/job/999")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://jobs.ashbyhq.com/acme/ashby-job-123",
        text: async () => ""
      };
    }

    // DOU test pages
    if (urlStr.includes("jobs.dou.ua/vacancies/internal-only")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => `<!DOCTYPE html><html><head><title>Backend Dev - DOU</title><meta property="og:title" content="Backend Dev"></head><body><h1>Backend Dev</h1><p>Apply via DOU internal messaging.</p></body></html>`
      };
    }
    if (urlStr.includes("jobs.dou.ua/vacancies/with-ats-link")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: urlStr,
        text: async () => `<!DOCTYPE html><html><head><title>Fullstack Dev - DOU</title></head><body><h1>Fullstack Dev</h1><a href="https://jobs.lever.co/acme/lever-job-456" class="b-btn">Відгукнутися на вакансію</a></body></html>`
      };
    }

    // SSRF test fixtures
    if (urlStr.includes("redirect-to-private-ip.com/job")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: "http://127.0.0.1/admin-secret",
        text: async () => "secret"
      };
    }
    if (urlStr.includes("redirect-302-private.com/job")) {
      return {
        status: 302,
        headers: {
          get: (h) => (h.toLowerCase() === "location" ? "http://192.168.1.1/secret" : null),
          location: "http://192.168.1.1/secret"
        },
        text: async () => ""
      };
    }
    if (urlStr.includes("redirect-302-non-http.com/job")) {
      return {
        status: 302,
        headers: {
          get: (h) => (h.toLowerCase() === "location" ? "ftp://evil.com/job" : null),
          location: "ftp://evil.com/job"
        },
        text: async () => ""
      };
    }

    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      url: urlStr,
      json: async () => ({ error: "Not Found" }),
      text: async () => "Not Found"
    };
  };
}

(async () => {
  const fetchImpl = createMockFetch();

  // 1. Invalid URL rejection & SSRF validation
  await assert.rejects(
    () => getJobPosting("chrome://settings", { fetchImpl }),
    /Only http: and https: URLs are allowed/,
    "Should reject chrome:// URLs"
  );
  await assert.rejects(
    () => getJobPosting("file:///etc/passwd", { fetchImpl }),
    /Only http: and https: URLs are allowed/,
    "Should reject file:// URLs"
  );
  await assert.rejects(
    () => getJobPosting("javascript:alert(1)", { fetchImpl }),
    /Only http: and https: URLs are allowed/,
    "Should reject javascript: URLs"
  );
  await assert.rejects(
    () => getJobPosting("", { fetchImpl }),
    /Invalid URL/,
    "Should reject empty URL string"
  );
  await assert.rejects(
    () => getJobPosting("not-a-valid-url", { fetchImpl }),
    /Invalid URL/,
    "Should reject malformed URL string"
  );

  // Direct private IP rejection
  await assert.rejects(
    () => getJobPosting("http://127.0.0.1:8765/job", { fetchImpl }),
    /Refused: private IP or disallowed host/,
    "Should reject 127.0.0.1"
  );
  await assert.rejects(
    () => getJobPosting("http://localhost:3000/job", { fetchImpl }),
    /Refused: private IP or disallowed host/,
    "Should reject localhost"
  );
  await assert.rejects(
    () => getJobPosting("http://10.0.0.5/job", { fetchImpl }),
    /Refused: private IP or disallowed host/,
    "Should reject 10/8 private IP"
  );
  await assert.rejects(
    () => getJobPosting("http://172.20.0.1/job", { fetchImpl }),
    /Refused: private IP or disallowed host/,
    "Should reject 172.16/12 private IP"
  );
  await assert.rejects(
    () => getJobPosting("http://192.168.1.100/job", { fetchImpl }),
    /Refused: private IP or disallowed host/,
    "Should reject 192.168/16 private IP"
  );
  await assert.rejects(
    () => getJobPosting("http://169.254.169.254/latest/meta-data", { fetchImpl }),
    /Refused: private IP or disallowed host/,
    "Should reject link-local 169.254/16"
  );
  console.log("✔ URL validation & initial private IP rejection passed!");

  // 2. Adapter URL detection & known ATS host recognition
  assert.strictEqual(detectAdapter(new URL("https://jobs.ashbyhq.com/acme/123")), "ashby");
  assert.strictEqual(detectAdapter(new URL("https://boards.greenhouse.io/acme/jobs/123")), "greenhouse");
  assert.strictEqual(detectAdapter(new URL("https://boards.eu.greenhouse.io/acme/jobs/123")), "greenhouse");
  assert.strictEqual(detectAdapter(new URL("https://eu.greenhouse.io/acme/jobs/123")), "greenhouse");
  assert.strictEqual(detectAdapter(new URL("https://job-boards.greenhouse.io/acme/jobs/123")), "greenhouse");
  assert.strictEqual(detectAdapter(new URL("https://jobs.lever.co/acme/123")), "lever");
  assert.strictEqual(detectAdapter(new URL("https://apply.workable.com/acme/j/123")), "workable");
  assert.strictEqual(detectAdapter(new URL("https://careers.company.com/job/123")), "generic");

  assert(isKnownAtsHost("jobs.ashbyhq.com"));
  assert(isKnownAtsHost("boards.greenhouse.io"));
  assert(isKnownAtsHost("jobs.lever.co"));
  assert(isKnownAtsHost("apply.workable.com"));
  assert(isKnownAtsHost("company.teamtailor.com"));
  assert(isKnownAtsHost("careers.recruitee.com"));
  assert(isKnownAtsHost("jobs.smartrecruiters.com"));
  assert(isKnownAtsHost("company.personio.de"));
  assert(isKnownAtsHost("company.breezy.hr"));
  assert(isKnownAtsHost("company.bamboohr.com"));
  assert(isKnownAtsHost("company.applytojob.com"));
  assert(!isKnownAtsHost("startup.jobs"));
  assert(!isKnownAtsHost("example.com"));

  assert(isAggregatorHost(new URL("https://startup.jobs/engineer")));
  assert(isAggregatorHost(new URL("https://www.welcometothejungle.com/fr/jobs/123")));
  assert(isAggregatorHost(new URL("https://bebee.com/job/123")));
  assert(isAggregatorHost(new URL("https://jobijoba.com/job/123")));
  assert(isAggregatorHost(new URL("https://www.linkedin.com/jobs/view/123")));
  assert(!isAggregatorHost(new URL("https://linkedin.com/in/profile")));
  console.log("✔ Adapter URL & aggregator detection passed!");

  // 3. TASK A: Summary mode shape & geoHints extraction on >5000 char description
  const ghSummary = await getJobPosting("https://boards.greenhouse.io/acme/jobs/12345", {
    fetchImpl,
    summary: true
  });
  // Check that descriptionText is omitted in summary mode
  assert.strictEqual(ghSummary.descriptionText, undefined, "descriptionText must be omitted in summary mode");
  assert.strictEqual(ghSummary.source, "greenhouse");
  assert.strictEqual(ghSummary.title, "Staff Backend Engineer");
  assert.strictEqual(ghSummary.company, "Acme Global");
  assert.strictEqual(ghSummary.location, "Remote, US");
  assert.strictEqual(ghSummary.remote, true);
  assert.strictEqual(ghSummary.compensation, "$190,000 - $240,000");
  assert(Array.isArray(ghSummary.questions), "questions must be an array");

  // requirementsText capped at 2500 chars
  assert(
    ghSummary.requirementsText && ghSummary.requirementsText.length <= 2500,
    `requirementsText must be <= 2500 chars (got ${ghSummary.requirementsText?.length})`
  );

  // geoHints checks: array, max 6, each <= 200 chars
  assert(Array.isArray(ghSummary.geoHints), "geoHints must be an array");
  assert(ghSummary.geoHints.length > 0, "geoHints should not be empty");
  assert(ghSummary.geoHints.length <= 6, `geoHints must have max 6 items (got ${ghSummary.geoHints.length})`);
  ghSummary.geoHints.forEach((hint, idx) => {
    assert(
      hint.length <= 200,
      `geoHint [${idx}] must be <= 200 chars (got ${hint.length}: "${hint}")`
    );
  });
  // Check geoHints content includes expected sentences
  assert(ghSummary.geoHints.some((h) => h.includes("must reside in the EU")));
  assert(ghSummary.geoHints.some((h) => h.includes("Remote (US only)")));
  assert(ghSummary.geoHints.some((h) => h.includes("CET timezone")));

  // Non-summary mode retains full description (>5000 chars) and descriptionText
  const ghFull = await getJobPosting("https://boards.greenhouse.io/acme/jobs/12345", { fetchImpl });
  assert(
    ghFull.descriptionText.length > 5000,
    `Default mode descriptionText must not be truncated (>5000 chars, got ${ghFull.descriptionText.length})`
  );
  assert.strictEqual(ghFull.geoHints, undefined, "geoHints should not be in default non-summary mode");
  console.log("✔ TASK A: Summary mode shape & geoHints extraction tests passed!");

  // 4. TASK B: Aggregator with outbound Ashby link resolves to Ashby adapter
  const aggAshby = await getJobPosting("https://startup.jobs/acme/software-engineer", {
    fetchImpl,
    summary: true
  });
  assert.strictEqual(aggAshby.source, "ashby", "Should resolve to Ashby adapter");
  assert.strictEqual(aggAshby.resolved, true, "Should set resolved: true");
  assert.strictEqual(aggAshby.resolvedFrom, "https://startup.jobs/acme/software-engineer");
  assert.strictEqual(aggAshby.url, "https://jobs.ashbyhq.com/acme/ashby-job-123");
  assert.strictEqual(aggAshby.title, "Senior Software Engineer");
  assert.strictEqual(aggAshby.company, "Acme");
  console.log("✔ Aggregator with outbound Ashby link test passed!");

  // 5. TASK B: Aggregator with outbound Greenhouse link
  const aggGreenhouse = await getJobPosting(
    "https://www.welcometothejungle.com/en/companies/acme/jobs/backend",
    { fetchImpl }
  );
  assert.strictEqual(aggGreenhouse.source, "greenhouse", "Should resolve to Greenhouse adapter");
  assert.strictEqual(aggGreenhouse.resolved, true);
  assert.strictEqual(
    aggGreenhouse.resolvedFrom,
    "https://www.welcometothejungle.com/en/companies/acme/jobs/backend"
  );
  assert.strictEqual(aggGreenhouse.url, "https://boards.greenhouse.io/acme/jobs/12345");
  assert.strictEqual(aggGreenhouse.title, "Staff Backend Engineer");
  console.log("✔ Aggregator with outbound Greenhouse link test passed!");

  // 6. TASK B: Aggregator with outbound Lever link (beBee)
  const bebeeRes = await getJobPosting("https://bebee.com/job/fullstack-platform-engineer", { fetchImpl });
  assert.strictEqual(bebeeRes.source, "lever", "beBee should resolve outbound Lever link");
  assert.strictEqual(bebeeRes.resolved, true);
  assert.strictEqual(bebeeRes.url, "https://jobs.lever.co/acme/lever-job-456");
  console.log("✔ Aggregator with outbound Lever link (beBee) test passed!");

  // 7. TASK B: Redirect to ATS via fetchImpl returning a different url
  const redirectRes = await getJobPosting("https://tracker.com/job/999", { fetchImpl });
  assert.strictEqual(redirectRes.source, "ashby");
  assert.strictEqual(redirectRes.resolved, true);
  assert.strictEqual(redirectRes.resolvedFrom, "https://tracker.com/job/999");
  assert.strictEqual(redirectRes.url, "https://jobs.ashbyhq.com/acme/ashby-job-123");
  assert.strictEqual(redirectRes.title, "Senior Software Engineer");
  console.log("✔ Redirect to ATS via fetchImpl test passed!");

  // 8. TASK B: Unresolved aggregator falls back with resolved:false
  const unresolvedRes = await getJobPosting("https://startup.jobs/solo/growth-lead-unresolved", {
    fetchImpl,
    summary: true
  });
  assert.strictEqual(unresolvedRes.source, "generic");
  assert.strictEqual(unresolvedRes.resolved, false, "Should set resolved: false");
  assert.strictEqual(unresolvedRes.resolvedFrom, "https://startup.jobs/solo/growth-lead-unresolved");
  assert.strictEqual(unresolvedRes.url, "https://startup.jobs/solo/growth-lead-unresolved");
  assert.strictEqual(unresolvedRes.title, "Growth Lead");
  console.log("✔ Unresolved aggregator fallback test passed!");

  // 9. TASK B: jobs.dou.ua keeps DOU page unless external ATS link
  const douInternal = await getJobPosting("https://jobs.dou.ua/vacancies/internal-only", { fetchImpl });
  assert.strictEqual(douInternal.source, "generic");
  assert.strictEqual(douInternal.resolved, false);
  assert.strictEqual(douInternal.url, "https://jobs.dou.ua/vacancies/internal-only");

  const douWithAts = await getJobPosting("https://jobs.dou.ua/vacancies/with-ats-link", { fetchImpl });
  assert.strictEqual(douWithAts.source, "lever");
  assert.strictEqual(douWithAts.resolved, true);
  assert.strictEqual(douWithAts.url, "https://jobs.lever.co/acme/lever-job-456");
  console.log("✔ jobs.dou.ua behavior tests passed!");

  // 10. TASK B: Private-IP / non-http redirect target is refused
  await assert.rejects(
    () => resolveApplyUrl("https://redirect-to-private-ip.com/job", { fetchImpl }),
    /Refused redirect to private IP or disallowed host/,
    "Should refuse redirect to 127.0.0.1"
  );
  await assert.rejects(
    () => resolveApplyUrl("https://redirect-302-private.com/job", { fetchImpl }),
    /Refused redirect to private IP or disallowed host/,
    "Should refuse 302 redirect to 192.168.1.1"
  );
  await assert.rejects(
    () => resolveApplyUrl("https://redirect-302-non-http.com/job", { fetchImpl }),
    /Refused redirect to non-http\(s\) protocol/,
    "Should refuse 302 redirect to ftp://"
  );
  console.log("✔ Private-IP and non-http redirect refusal tests passed!");

  // 11. Core ATS adapter tests
  // Ashby direct
  const ashbyRes = await getJobPosting("https://jobs.ashbyhq.com/acme/ashby-job-123", { fetchImpl });
  assert.strictEqual(ashbyRes.source, "ashby");
  assert.strictEqual(ashbyRes.title, "Senior Software Engineer");
  assert.strictEqual(ashbyRes.company, "Acme");
  assert.strictEqual(ashbyRes.location, "San Francisco, CA");
  assert.strictEqual(ashbyRes.remote, true);
  assert.strictEqual(ashbyRes.compensation, "$180,000 - $220,000 USD");
  assert(ashbyRes.descriptionText.includes("Welcome to Acme!"));

  // Greenhouse EU direct
  const ghEuRes = await getJobPosting("https://boards.eu.greenhouse.io/acme-eu/jobs/67890", { fetchImpl });
  assert.strictEqual(ghEuRes.source, "greenhouse");
  assert.strictEqual(ghEuRes.title, "Frontend Engineer (EU)");
  assert.strictEqual(ghEuRes.company, "Acme Europe");

  // Lever direct
  const leverRes = await getJobPosting("https://jobs.lever.co/acme/lever-job-456", { fetchImpl });
  assert.strictEqual(leverRes.source, "lever");
  assert.strictEqual(leverRes.title, "Fullstack Platform Engineer");

  // Workable direct
  const workableRes = await getJobPosting("https://apply.workable.com/acme/j/WORK999", { fetchImpl });
  assert.strictEqual(workableRes.source, "workable");
  assert.strictEqual(workableRes.title, "Lead DevOps & Infrastructure Engineer");
  console.log("✔ Core ATS adapter direct tests passed!");

  // 12. MCP Schema test: get_job_posting has summary
  const getPostingTool = TOOLS.find((t) => t.name === "get_job_posting");
  assert(getPostingTool, "TOOLS must contain get_job_posting");
  assert.deepStrictEqual(getPostingTool.inputSchema.required, ["url"]);
  assert.strictEqual(getPostingTool.inputSchema.properties.url.type, "string");
  assert(
    getPostingTool.inputSchema.properties.summary,
    "get_job_posting schema must have summary parameter"
  );
  assert.strictEqual(getPostingTool.inputSchema.properties.summary.type, "boolean");
  assert(
    getPostingTool.description.includes(
      "use summary:true when screening vacancies (small output); use default for application materials"
    ),
    "Tool description must include screening vs drafting usage note"
  );
  console.log("✔ MCP schema test passed!");

  console.log("✔ All Job Posting, Aggregator Resolver & Summary Mode tests passed!");
})();
