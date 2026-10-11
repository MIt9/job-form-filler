const fs = require('fs');
const path = require('path');
const { getJobPosting } = require('./job-posting');

/**
 * Get RESUME_REPO_PATH at runtime, not require-time (for testing)
 */
function getResumeRepoPath() {
  const repo = process.env.RESUME_REPO_PATH;
  if (!repo) throw new Error('RESUME_REPO_PATH is not set: point it at your resume folder to use log_application');
  return repo;
}

/**
 * Generate URL/company+date key for idempotency check
 */
function getIdempotencyKey(company, date, url) {
  if (url) return url;
  return `${company}__${date}`;
}

/**
 * Convert company name to slug: lowercase, non-alphanumerics to '-'
 */
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check if profile folder exists under resume/
 */
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Profiles live in <repo>/resume/<profile>/ (same layouts as profile-loader: <repo>/<role>/ also works).
function profileRoots() {
  const repo = getResumeRepoPath();
  const nested = path.join(repo, 'resume');
  return isDir(nested) ? [nested, repo] : [repo];
}

function profileDir(profile) {
  if (!profile || /[\\/]/.test(profile) || profile.startsWith('.')) return null;
  for (const root of profileRoots()) {
    const dir = path.join(root, profile);
    if (isDir(dir)) return dir;
  }
  return null;
}

// Resume markdown inside a role folder: first `resume*.md` (e.g. resume-jane-doe.md).
function resumeMdName(dir) {
  return fs.readdirSync(dir).filter((n) => /^resume.*\.md$/i.test(n)).sort()[0] || null;
}

function validateProfile(profile) {
  if (profileDir(profile)) return;
  const [root] = profileRoots();
  const valid = fs.readdirSync(root)
    .filter((p) => isDir(path.join(root, p)) && resumeMdName(path.join(root, p)));
  throw new Error(`Profile '${profile}' does not exist. Valid profiles: ${valid.join(', ')}`);
}

// One table cell: `<folder>` — notes (matches the real applications-log.md rows)
function folderCell(relFolder, notes, url) {
  const n = escapePipes(notes || '').trim();
  return [`\`${relFolder}\``, n, url].filter(Boolean).join(" — ");
}

/**
 * Read applications-log.md and detect if already logged
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Already logged? The URL is the identity when given (two roles at one company on the same day are
 * different vacancies). Without a URL: an exact "## Skipped — <company> (<date>)" block or an exact
 * table row "| <date> | <company> |" — never loose substrings spread over the whole file.
 */
function checkAlreadyLogged(company, date, url, role) {
  const logPath = path.join(getResumeRepoPath(), 'info/applications-log.md');
  if (!fs.existsSync(logPath)) return false;
  const content = fs.readFileSync(logPath, 'utf8');

  if (url && content.includes(url)) return true;
  // Submitted rows do not carry the URL: identify them by the exact "| date | company | role |" prefix.
  if (role && new RegExp(`^\\| ${escapeRegExp(date)} \\| ${escapeRegExp(company)} \\| ${escapeRegExp(role)} \\|`, "m").test(content)) return true;
  if (url) return false;

  const c = escapeRegExp(company);
  const d = escapeRegExp(date);
  if (new RegExp(`^## Skipped — ${c} \\(${d}\\)`, 'm').test(content)) return true;
  if (new RegExp(`^\\| ${d} \\| ${c} \\|`, 'm').test(content)) return true;
  return false;
}

/**
 * Escape pipes in markdown text
 */
function escapePipes(text) {
  return text ? text.replace(/\|/g, '\\|') : '';
}

/**
 * Insert Skipped block at top of log file (after intro paragraph)
 */
function insertSkippedBlock(content, company, date, role, profile, url, reason) {
  const lines = content.split('\n');
  let introEnd = 0;

  // Find end of title and intro paragraph
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## Skipped')) {
      introEnd = i;
      break;
    }
    if (lines[i].startsWith('|') && lines[i].includes('---')) {
      introEnd = i;
      break;
    }
  }

  if (introEnd === 0) introEnd = lines.length;

  const block = `## Skipped — ${company} (${date}): ${role}, ${profile} profile, ${url || '(no url)'} — ${reason}`;
  if (lines[introEnd]?.startsWith('## Skipped')) {
    // Newest first: block + one blank line, directly above the previous newest block.
    lines.splice(introEnd, 0, block, '');
  } else {
    // No Skipped block yet: one blank line between the intro and the new block.
    while (introEnd > 0 && lines[introEnd - 1].trim() === '') introEnd--;
    lines.splice(introEnd, 0, '', block, '');
  }

  return lines.join('\n');
}

/**
 * Append submitted row to log file table
 */
function appendSubmittedRow(content, date, company, role, profile, relFolder, notes, url) {
  const lines = content.split('\n');
  let lastRowIndex = -1;

  // Find last line starting with '| 20'
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('| 20')) {
      lastRowIndex = i;
      break;
    }
  }

  if (lastRowIndex === -1) {
    // No table found, append with minimal structure
    content += `\n| ${date} | ${company} | ${role} | ${profile} | ${folderCell(relFolder, notes, url)} |`;
    return content;
  }

  const row = `| ${date} | ${company} | ${role} | ${profile} | ${folderCell(relFolder, notes, url)} |`;
  lines.splice(lastRowIndex + 1, 0, row);

  return lines.join('\n');
}

/**
 * Insert bullet into profile resume Applications section
 */
function insertApplicationsBullet(resumeContent, company, role, slug) {
  const lines = resumeContent.split('\n');
  let sectionStart = -1;
  let sectionEnd = lines.length;

  // Find "## Applications submitted under this profile" section
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('## Applications submitted under this profile')) {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart === -1) {
    // Section doesn't exist, create it
    let insertIdx = lines.length;
    
    // Find "## Interests" section if it exists
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## Interests')) {
        insertIdx = i;
        break;
      }
    }

    const newSection = `## Applications submitted under this profile\n\n- **${company}** — ${role} — see \`applications/${slug}/\``;
    lines.splice(insertIdx, 0, newSection, '');
    return lines.join('\n');
  }

  // Find end of section: next ## or --- (separator)
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('##') || lines[i] === '---') {
      sectionEnd = i;
      break;
    }
  }

  // Find last bullet (line starting with '-') within section
  let lastBulletIdx = sectionStart;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (lines[i].startsWith('-')) {
      lastBulletIdx = i;
    }
  }

  // Check for duplicates
  for (let i = sectionStart; i < sectionEnd; i++) {
    if (lines[i].includes(`\`applications/${slug}/\``)) {
      return resumeContent; // Already exists
    }
  }

  const bullet = `- **${company}** — ${role} — see \`applications/${slug}/\``;
  lines.splice(lastBulletIdx + 1, 0, bullet);

  return lines.join('\n');
}

/**
 * Create job-posting.md content
 */
async function createJobPostingContent(jobPostingText, url, company, fetchPosting, date) {
  if (jobPostingText) {
    return jobPostingText;
  }

  if (fetchPosting && url) {
    try {
      const posting = await getJobPosting(url);
      if (posting && posting.descriptionText) {
        return posting.descriptionText;
      }
    } catch (e) {
      // Fall through to minimal header
    }
  }

  // Minimal header
  return `# ${company} Job Posting\n\nSource: ${url || 'N/A'}\nDate: ${date}`;
}

/**
 * Main log_application function
 */
async function logApplication(input) {
  const {
    company,
    role,
    profile,
    url,
    status,
    notes = '',
    date = new Date().toISOString().split('T')[0],
    jobPostingText,
    fetchPosting = false,
    dryRun = false,
  } = input;

  // Validation
  if (!company || !company.trim()) {
    throw new Error('company is required and must be non-empty');
  }
  if (!role || !role.trim()) {
    throw new Error('role is required and must be non-empty');
  }
  if (!status || !['submitted', 'skipped'].includes(status)) {
    throw new Error('status must be "submitted" or "skipped"');
  }
  if (url && !/^https?:\/\//.test(url)) {
    throw new Error('url must be http(s) if present');
  }

  validateProfile(profile);

  // Check idempotency
  if (checkAlreadyLogged(company, date, url, role)) {
    return { alreadyLogged: true };
  }

  const resumeRepoPath = getResumeRepoPath();
  const slug = toSlug(company);
  const logPath = path.join(resumeRepoPath, 'info/applications-log.md');
  const pDir = profileDir(profile);
  const profileResumePath = path.join(pDir, resumeMdName(pDir) || 'resume.md');
  const applicationFolderPath = path.join(pDir, 'applications', slug);
  const relFolder = path.relative(resumeRepoPath, applicationFolderPath).split(path.sep).join('/') + '/';
  const jobPostingPath = path.join(applicationFolderPath, 'job-posting.md');

  const changes = {
    logFile: logPath,
    applicationFolder: applicationFolderPath,
    created: [],
    alreadyLogged: false,
    rowOrBlock: null,
    profileResume: null,
  };

  // Update applications-log.md
  let logContent = '';
  if (fs.existsSync(logPath)) {
    logContent = fs.readFileSync(logPath, 'utf8');
  } else {
    logContent = '# Applications Log\n\nTracker of job applications submitted and skipped.\n\n';
  }

  if (status === 'skipped') {
    const newContent = insertSkippedBlock(logContent, company, date, role, profile, url || '(no url)', notes);
    const block = `## Skipped — ${company} (${date}): ${role}, ${profile} profile, ${url || '(no url)'} — ${notes}`;
    changes.rowOrBlock = block;

    if (!dryRun) {
      fs.writeFileSync(logPath, newContent, 'utf8');
    }
  } else {
    // submitted
    const newContent = appendSubmittedRow(logContent, date, company, role, profile, relFolder, notes, url);
    const row = `| ${date} | ${company} | ${role} | ${profile} | ${folderCell(relFolder, notes, url)} |`;
    changes.rowOrBlock = row;

    if (!dryRun) {
      fs.writeFileSync(logPath, newContent, 'utf8');
    }

    // Update profile resume
    let resumeContent = fs.readFileSync(profileResumePath, 'utf8');
    const newResumeContent = insertApplicationsBullet(resumeContent, company, role, slug);
    const bullet = `- **${company}** — ${role} — see \`applications/${slug}/\``;
    changes.profileResume = `${profileResumePath}:${bullet}`;

    if (!dryRun) {
      fs.writeFileSync(profileResumePath, newResumeContent, 'utf8');
    }

    // Create job-posting.md if missing
    if (!fs.existsSync(jobPostingPath)) {
      const postingContent = await createJobPostingContent(jobPostingText, url, company, fetchPosting, date);
      if (!dryRun) {
        fs.mkdirSync(applicationFolderPath, { recursive: true });
        fs.writeFileSync(jobPostingPath, postingContent, 'utf8');
      }
      changes.created.push(jobPostingPath);
    }
  }

  return changes;
}

module.exports = { logApplication };
