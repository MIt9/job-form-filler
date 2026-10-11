const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logApplication } = require('../server/log-application');

// Create test resume repo
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jff-log-app-'));
const repoPath = path.join(tempDir, 'resume-repo');
fs.mkdirSync(repoPath, { recursive: true });

// Create test-profile with Applications section at end
const testProfilePath = path.join(repoPath, 'test-profile');
fs.mkdirSync(testProfilePath, { recursive: true });
fs.writeFileSync(
  path.join(testProfilePath, 'resume-dmytro-bilukha.md'),
  `# Test Resume

## Experience

- Senior Engineer at Acme

## Applications submitted under this profile

- **Acme AI** — Senior AI Engineer — see \`applications/acme-ai/\`

## Interests

- AI, ML, distributed systems
`,
  'utf8'
);

// Create growth-profile with Applications section mid-file (before separator)
const growthProfilePath = path.join(repoPath, 'growth-profile');
fs.mkdirSync(growthProfilePath, { recursive: true });
fs.writeFileSync(
  path.join(growthProfilePath, 'resume-dmytro-bilukha.md'),
  `# Growth Resume

## Experience

- Growth Lead at StartupCo

## Applications submitted under this profile

- **Growth Startup** — Growth Lead — see \`applications/growth-startup/\`

---

## Interests

- Growth hacking, metrics, experimentation
`,
  'utf8'
);

// Create fullstack-profile with no Applications section
const fullstackProfilePath = path.join(repoPath, 'fullstack-profile');
fs.mkdirSync(fullstackProfilePath, { recursive: true });
fs.writeFileSync(
  path.join(fullstackProfilePath, 'resume-dmytro-bilukha.md'),
  `# Fullstack Resume

## Experience

- Fullstack Engineer at TechCo
`,
  'utf8'
);

// Create info directory with applications-log.md
const infoPath = path.join(repoPath, 'info');
fs.mkdirSync(infoPath, { recursive: true });
fs.writeFileSync(
  path.join(infoPath, 'applications-log.md'),
  `# Applications Log

Tracker of job applications submitted and skipped.

## Skipped — OldCorp (2026-09-01): Senior Dev, test-profile profile, https://oldcorp.com/jobs/dev — Not a fit

## Skipped — LegacyInc (2026-09-02): Principal Eng, test-profile profile, https://legacyinc.com/apply — Too many legacy systems

| Date | Company | Role | Profile | Link | Notes |
|------|---------|------|---------|------|-------|
| 2026-08-01 | TechCorp | Senior Engineer | test-profile | \`resume/test-profile/applications/techcorp/\` | Great fit |
| 2026-08-05 | DataPlatform | Lead | test-profile | \`resume/test-profile/applications/dataplatform/\` | Remote friendly |
`,
  'utf8'
);

// Set env var for tests
const originalEnv = process.env.RESUME_REPO_PATH;
process.env.RESUME_REPO_PATH = repoPath;

try {
  console.log('▶ Testing log_application...');

  // Test 1: Log a submitted application
  console.log('  ▸ Test: log submitted application');
  const r1 = require('util').promisify((cb) => {
    logApplication({
      company: 'NewTech',
      role: 'Senior Engineer',
      profile: 'test-profile',
      url: 'https://newtech.com/jobs/eng',
      status: 'submitted',
      notes: 'Strong match',
      date: '2026-10-05'
    }).then(res => cb(null, res)).catch(cb);
  })();

  r1.then(result => {
    assert.strictEqual(result.alreadyLogged, false);
    assert(result.logFile.includes('applications-log.md'));
    assert(result.rowOrBlock.includes('2026-10-05'));
    assert(result.rowOrBlock.includes('NewTech'));
    const logContent = fs.readFileSync(result.logFile, 'utf8');
    assert(logContent.includes('NewTech'));
    const resumeContent = fs.readFileSync(path.join(repoPath, 'test-profile/resume-dmytro-bilukha.md'), 'utf8');
    assert(resumeContent.includes('**NewTech**'));
    console.log('  ✔ submitted application logged');
  }).then(() => {
    // Test 2: Log a skipped application
    console.log('  ▸ Test: log skipped application');
    return logApplication({
      company: 'SkipCorp',
      role: 'Junior Dev',
      profile: 'test-profile',
      url: 'https://skipcorp.com/jobs/junior',
      status: 'skipped',
      notes: 'Too junior',
      date: '2026-10-04'
    });
  }).then(result => {
    assert.strictEqual(result.alreadyLogged, false);
    assert(result.rowOrBlock.includes('## Skipped'));
    assert(result.rowOrBlock.includes('SkipCorp'));
    console.log('  ✔ skipped application logged');
  }).then(() => {
    // Test 3: Detect duplicate by URL
    console.log('  ▸ Test: detect duplicate by URL');
    return logApplication({
      company: 'NewTech',
      role: 'Senior Engineer',
      profile: 'test-profile',
      url: 'https://newtech.com/jobs/eng',
      status: 'submitted'
    });
  }).then(result => {
    assert.strictEqual(result.alreadyLogged, true);
    console.log('  ✔ duplicate detection by URL works');
  }).then(() => {
    // Test 4: Detect duplicate by company+date
    console.log('  ▸ Test: detect duplicate by company+date');
    return logApplication({
      company: 'DupCorp',
      role: 'Engineer',
      profile: 'test-profile',
      status: 'skipped',
      date: '2026-10-03'
    }).then(() => logApplication({
      company: 'DupCorp',
      role: 'Different Role',
      profile: 'test-profile',
      status: 'skipped',
      date: '2026-10-03'
    }));
  }).then(result => {
    assert.strictEqual(result.alreadyLogged, true);
    console.log('  ✔ duplicate detection by company+date works');
  }).then(() => {
    // Test 5: dryRun mode
    console.log('  ▸ Test: dryRun mode');
    return logApplication({
      company: 'DryRunCorp',
      role: 'Test Role',
      profile: 'test-profile',
      url: 'https://dryrun.test/jobs',
      status: 'submitted',
      date: '2026-10-02',
      dryRun: true
    });
  }).then(result => {
    assert.strictEqual(result.alreadyLogged, false);
    assert(result.rowOrBlock);
    const logContent = fs.readFileSync(path.join(repoPath, 'info/applications-log.md'), 'utf8');
    assert(!logContent.includes('DryRunCorp'));
    console.log('  ✔ dryRun mode works (no writes)');
  }).then(() => {
    // Test 6: Escape pipes in notes
    console.log('  ▸ Test: escape pipes in notes');
    return logApplication({
      company: 'PipeCorp',
      role: 'Eng | Lead',
      profile: 'test-profile',
      url: 'https://pipecorp.test/jobs',
      status: 'submitted',
      notes: 'Notes | with | pipes',
      date: '2026-10-01'
    });
  }).then(result => {
    const logContent = fs.readFileSync(result.logFile, 'utf8');
    assert(logContent.includes('\\|'));
    console.log('  ✔ pipe escaping works');
  }).then(() => {
    // Test 7: Slug generation
    console.log('  ▸ Test: slug generation');
    return logApplication({
      company: 'Test & Co.™ (Inc)',
      role: 'Developer',
      profile: 'test-profile',
      url: 'https://testcoinc.test/jobs',
      status: 'submitted',
      date: '2026-09-30'
    });
  }).then(result => {
    assert(result.profileResume.includes('test-co-inc'));
    console.log('  ✔ slug generation works (non-alphanumerics → hyphens)');
  }).then(() => {
    // Test 8: Validate profile exists
    console.log('  ▸ Test: validate profile exists');
    return logApplication({
      company: 'TestCorp',
      role: 'Developer',
      profile: 'nonexistent-profile',
      status: 'submitted'
    }).then(() => assert.fail('Should have thrown')).catch(err => {
      assert(err.message.includes('does not exist'));
      console.log('  ✔ profile validation works');
    });
  }).then(() => {
    // Test 9: Validate status enum
    console.log('  ▸ Test: validate status enum');
    return logApplication({
      company: 'TestCorp',
      role: 'Developer',
      profile: 'test-profile',
      status: 'invalid-status'
    }).then(() => assert.fail('Should have thrown')).catch(err => {
      assert(err.message.includes('submitted') || err.message.includes('skipped'));
      console.log('  ✔ status validation works');
    });
  }).then(() => {
    // Test 10: Validate company/role non-empty
    console.log('  ▸ Test: validate company/role non-empty');
    return logApplication({
      company: '',
      role: 'Developer',
      profile: 'test-profile',
      status: 'submitted'
    }).then(() => assert.fail('Should have thrown')).catch(err => {
      assert(err.message.includes('company'));
      console.log('  ✔ company validation works');
    });
  }).then(() => {
    // Test 11: Validate URL format
    console.log('  ▸ Test: validate URL format');
    return logApplication({
      company: 'TestCorp',
      role: 'Developer',
      profile: 'test-profile',
      url: 'not-a-url',
      status: 'submitted'
    }).then(() => assert.fail('Should have thrown')).catch(err => {
      assert(err.message.includes('http'));
      console.log('  ✔ URL validation works');
    });
  }).then(() => {
    // Test 12: Profile mid-file section
    console.log('  ▸ Test: Applications section mid-file before separator');
    return logApplication({
      company: 'MidFileCorp',
      role: 'Growth Analyst',
      profile: 'growth-profile',
      url: 'https://midfile.test/jobs',
      status: 'submitted',
      date: '2026-09-29'
    });
  }).then(result => {
    const resumeContent = fs.readFileSync(path.join(repoPath, 'growth-profile/resume-dmytro-bilukha.md'), 'utf8');
    const lines = resumeContent.split('\n');
    let bulletIdx = -1;
    let separatorIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('**MidFileCorp**')) bulletIdx = i;
      if (lines[i] === '---') separatorIdx = i;
    }

    assert(bulletIdx >= 0, 'Bullet should exist');
    assert(bulletIdx < separatorIdx, 'Bullet should be before separator');
    console.log('  ✔ Applications section insertion respects separators');
  }).then(() => {
    // Test 13: Create Applications section when missing
    console.log('  ▸ Test: create Applications section when missing');
    return logApplication({
      company: 'NoSectionCorp',
      role: 'Full-Stack Dev',
      profile: 'fullstack-profile',
      url: 'https://nosection.test/jobs',
      status: 'submitted',
      date: '2026-09-28'
    });
  }).then(result => {
    const resumeContent = fs.readFileSync(path.join(repoPath, 'fullstack-profile/resume-dmytro-bilukha.md'), 'utf8');
    assert(resumeContent.includes('## Applications submitted under this profile'));
    assert(resumeContent.includes('**NoSectionCorp**'));
    console.log('  ✔ Applications section created when missing');
  }).then(() => {
    // Test 14: Never place Applications after ## Interests
    console.log('  ▸ Test: Applications section never after ## Interests');
    // Check that in fullstack-profile, Applications comes before end
    const resumeContent = fs.readFileSync(path.join(repoPath, 'fullstack-profile/resume-dmytro-bilukha.md'), 'utf8');
    const lines = resumeContent.split('\n');
    let appIdx = -1;
    let interestIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('## Applications')) appIdx = i;
      if (lines[i].includes('## Interests')) interestIdx = i;
    }

    if (interestIdx >= 0) {
      assert(appIdx < interestIdx || appIdx === -1, 'Applications should not come after Interests');
    }
    console.log('  ✔ Applications section placement correct');
  }).then(() => {
    // Test 15: Create job-posting.md
    console.log('  ▸ Test: create job-posting.md');
    return logApplication({
      company: 'PostingCorp',
      role: 'Engineer',
      profile: 'test-profile',
      url: 'https://posting.test/jobs',
      status: 'submitted',
      jobPostingText: '# Job Description\n\nThis is a test posting.',
      date: '2026-09-26'
    });
  }).then(result => {
    const postingPath = path.join(repoPath, 'test-profile/applications/postingcorp/job-posting.md');
    assert(fs.existsSync(postingPath));
    const postingContent = fs.readFileSync(postingPath, 'utf8');
    assert(postingContent.includes('# Job Description'));
    console.log('  ✔ job-posting.md created');
  }).then(() => {
    // Test 16: Default date to today
    console.log('  ▸ Test: default date to today');
    return logApplication({
      company: 'DefaultDateCorp',
      role: 'Engineer',
      profile: 'test-profile',
      url: 'https://defaultdate.test/jobs',
      status: 'submitted'
    });
  }).then(result => {
    const today = new Date().toISOString().split('T')[0];
    const logContent = fs.readFileSync(result.logFile, 'utf8');
    assert(logContent.includes(today));
    console.log('  ✔ default date works');
  }).then(() => {
    // Test 17: Handle skipped without URL
    console.log('  ▸ Test: skipped without URL');
    return logApplication({
      company: 'NoUrlCorp',
      role: 'Engineer',
      profile: 'test-profile',
      status: 'skipped',
      notes: 'Remote not available',
      date: '2026-09-24'
    });
  }).then(result => {
    assert.strictEqual(result.alreadyLogged, false);
    assert(result.rowOrBlock.includes('NoUrlCorp'));
    console.log('  ✔ skipped without URL works');
  }).then(() => {
    console.log('✔ All log_application tests passed!');
  }).catch(err => {
    console.error('✖ Test failed:', err.message);
    process.exit(1);
  }).finally(() => {
    // Cleanup
    process.env.RESUME_REPO_PATH = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
} catch (err) {
  console.error('✖ Setup error:', err.message);
  process.env.RESUME_REPO_PATH = originalEnv;
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}
