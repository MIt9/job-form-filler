/**
 * Djinni job-posting adapter tests.
 *
 * Strategy:
 *  - fixture-based: injects the REAL djinni-vacancy.html (fetched 2026-10-22 from
 *    https://djinni.co/jobs/854193-senior-full-stack-tech-lead-ai-native/) via a
 *    mock fetchImpl so parseDjinniHtml() runs against actual markup.
 *  - no live network calls in this test suite.
 */

"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  getJobPosting,
  isDjinniHost,
  detectAdapter,
  validateUrl,
  parseDjinniHtml,
  parseDjinniSidebar
} = require("../server/job-posting");

const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, "fixtures/djinni-vacancy.html"),
  "utf8"
);
const FIXTURE_URL = "https://djinni.co/jobs/854193-senior-full-stack-tech-lead-ai-native/";

// Minimal mock fetch that returns our saved fixture HTML
function mockFetch(url) {
  const u = typeof url === "string" ? url : url.toString();
  if (u.includes("djinni.co/jobs/854193")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      url: u,
      text: async () => FIXTURE_HTML
    });
  }
  return Promise.reject(new Error(`Unexpected URL in mock: ${u}`));
}

console.log("▶ Testing Djinni job-posting adapter...");

(async () => {
  // ── isDjinniHost ────────────────────────────────────────────────────────
  {
    assert.strictEqual(isDjinniHost(validateUrl("https://djinni.co/jobs/123-slug/")), true);
    assert.strictEqual(isDjinniHost(validateUrl("https://www.djinni.co/jobs/1/")), true);
    assert.strictEqual(isDjinniHost(validateUrl("https://dou.ua/vacancies/1/")), false);
    assert.strictEqual(isDjinniHost(validateUrl("https://example.com/")), false);
    console.log("✔ isDjinniHost");
  }

  // ── detectAdapter ───────────────────────────────────────────────────────
  {
    assert.strictEqual(detectAdapter(validateUrl("https://djinni.co/jobs/854193-ai-native/")), "djinni");
    assert.strictEqual(detectAdapter(validateUrl("https://djinni.co/jobs/")), "djinni");
    assert.strictEqual(detectAdapter(validateUrl("https://dou.ua/vacancies/1/")), "generic");
    console.log("✔ detectAdapter returns djinni");
  }

  // ── Bare-ID URL rejected ─────────────────────────────────────────────────
  {
    await assert.rejects(
      () => getJobPosting("https://djinni.co/jobs/854193/", { fetchImpl: mockFetch }),
      /requires a slug/i,
      "Bare numeric ID must be rejected with a clear slug-required message"
    );
    console.log("✔ Bare djinni /jobs/<id>/ rejected with slug-required message");
  }

  // ── parseDjinniHtml against real fixture ─────────────────────────────────
  {
    const result = parseDjinniHtml(FIXTURE_HTML, FIXTURE_URL);

    // Source
    assert.strictEqual(result.source, "djinni");

    // Title: extracted from og:title without "в Company" suffix
    assert.ok(result.title.length > 0, "title must not be empty");
    assert.ok(result.title.toLowerCase().includes("tech lead") || result.title.toLowerCase().includes("full-stack"),
      `title should mention tech lead or full-stack, got: ${result.title}`);
    // Must NOT contain " в " (the company part stripped)
    assert.ok(!/ в /.test(result.title), `title must not contain " в ", got: ${result.title}`);

    // Company
    assert.ok(result.company.length > 0, "company must not be empty");

    // Description extracted
    assert.ok(result.descriptionText && result.descriptionText.length > 100,
      "descriptionText must be non-empty");

    // Sidebar facts from real fixture (2026-10-22 Senior Full-Stack Tech Lead AI-native vacancy)
    assert.strictEqual(result.experience_min_years, 5, `experience_min_years expected 5, got ${result.experience_min_years}`);
    assert.strictEqual(result.location_type, "remote", `location_type expected remote, got ${result.location_type}`);
    assert.strictEqual(result.remote, true);
    assert.ok(result.english_level && result.english_level.includes("B2"),
      `english_level expected B2, got: ${result.english_level}`);
    assert.ok(result.employment && /Fulltime/i.test(result.employment),
      `employment expected Fulltime, got: ${result.employment}`);
    assert.ok(result.domain && result.domain.length > 0, "domain must be set");
    assert.ok(result.company_type && result.company_type.length > 0, "company_type must be set");

    assert.strictEqual(result.requiredSkills, "React.js, TypeScript, Node.js, Claude Code");
    assert.strictEqual(result.languageRequirement, "Англійська B2 – Вище середнього");
    assert.strictEqual(result.countries, "Весь світ");
    assert.strictEqual(result.views, 389);
    assert.strictEqual(result.applications, 217);
    assert.strictEqual(result.has_test_task, false);
    assert.strictEqual(result.recruiter_activity, null); // not shown on this vacancy
    assert.strictEqual(result.company_type, "startup");
    assert.strictEqual(result.employment, "Fulltime");
    assert.strictEqual(result.domain, "HRTech");
    assert.ok(/Fully remote/.test(result.descriptionText), "description body present");
    assert.ok(!/Надіслати відгук|Відгукнутися/.test(result.descriptionText), "description must not include apply form");

    // Compensation is null (login-only)
    assert.strictEqual(result.compensation, null);

    // Questions array present (empty for non-ATS adapter)
    assert.ok(Array.isArray(result.questions));

    console.log("✔ parseDjinniHtml against real fixture");
    console.log(`  title: "${result.title}"`);
    console.log(`  company: "${result.company}"`);
    console.log(`  experience_min_years: ${result.experience_min_years}`);
    console.log(`  location_type: ${result.location_type}, english_level: ${result.english_level}`);
    console.log(`  employment: ${result.employment}, domain: ${result.domain}, company_type: ${result.company_type}`);
    console.log(`  countries: ${result.countries}, views: ${result.views}, applications: ${result.applications}`);
  }

  // ── parseDjinniSidebar unit tests ────────────────────────────────────────
  {
    // Synthesise minimal aside HTML matching the pattern we observed
    const asideHtml = `
      <ul>
        <li><strong>Виключно від 5 років досвіду</strong></li>
        <li><strong>Тільки віддалено</strong></li>
        <li><strong><span class="location-text">Весь світ</span></strong>
          <div>Країни, де розглядаємо кандидатів</div></li>
        <li><strong>Англійська B2 – Вище середнього</strong></li>
      </ul>
      <ul>
        <li><div>Зайнятість: Fulltime</div></li>
        <li><div>Домен: HRTech</div></li>
        <li><div>Стартап</div></li>
        <li><div>Є тестове завдання</div></li>
        <li><div>Активність рекрутера: Висока</div></li>
        <li><div>Відповідали 2 тижні тому</div></li>
        <li>389 переглядів · 217 відгуків</li>
      </ul>`;

    const sb = parseDjinniSidebar(asideHtml);
    assert.strictEqual(sb.experience_min_years, 5);
    assert.strictEqual(sb.location_type, "remote");
    assert.strictEqual(sb.english_level, "B2 – Вище середнього");
    assert.strictEqual(sb.employment, "Fulltime");
    assert.strictEqual(sb.domain, "HRTech");
    assert.strictEqual(sb.company_type, "startup");
    assert.strictEqual(sb.has_test_task, true);
    assert.strictEqual(sb.recruiter_activity, "Висока");
    assert.strictEqual(sb.views, 389);
    assert.strictEqual(sb.applications, 217);
    assert.strictEqual(sb.countries, "Весь світ");
    console.log("✔ parseDjinniSidebar synthetic tests");
  }

  // ── getJobPosting end-to-end with mock fetch ─────────────────────────────
  {
    const result = await getJobPosting(FIXTURE_URL, { fetchImpl: mockFetch });
    assert.strictEqual(result.source, "djinni");
    assert.ok(result.title.length > 0);
    console.log("✔ getJobPosting with mock fetchImpl");
  }

  // ── Vacancy with no English line in aside ────────────────────────────────
  {
    // Minimal aside with "Без досвіду" and a product company
    const asideHtml = `<ul><li>Без досвіду</li><li>Тільки в офісі</li><li>Продуктова компанія</li></ul>`;
    const sb = parseDjinniSidebar(asideHtml);
    assert.strictEqual(sb.experience_min_years, 0);
    assert.strictEqual(sb.location_type, "office");
    assert.strictEqual(sb.company_type, "product");
    assert.strictEqual(sb.english_level, undefined);
    console.log("✔ parseDjinniSidebar: Без досвіду / in-office / product company");
  }

  console.log("✔ All Djinni job-posting adapter tests passed!");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
