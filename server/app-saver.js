const fs = require("fs");
const path = require("path");
const { DEFAULT_RESUME_REPO_PATH, DATA_DIR, loadProfiles } = require("./profile-loader");

/**
 * Saves job application artifacts to
 *   <role folder in RESUME_REPO_PATH>/applications/<company>/   (when a role variant is used)
 *   ~/.job-form-filler/applications/<company>/                     (otherwise)
 */
function saveApplication({
  repoPath = DEFAULT_RESUME_REPO_PATH,
  profileKey,
  company,
  jobTitle,
  url,
  jobDescription,
  coverLetter = ""
}) {
  if (!company) {
    throw new Error("Company name is required to save application");
  }

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const companySlug = slug(company) || "company";

  const roleDir = profileKey && loadProfiles(repoPath).profiles[profileKey]?.path;
  const appDir = path.join(roleDir || DATA_DIR, "applications", companySlug);

  fs.mkdirSync(appDir, { recursive: true });

  const today = new Date().toISOString().split("T")[0];

  // 1. Create job-posting.md
  const jobPostingContent = `# ${jobTitle || "Role"} — ${company}

**Source:** ${url || "Direct Career Page"} (extracted ${today})

## Job Description (Clean Extracted Text)

${jobDescription || "No job description text provided."}

## Notes
- Extracted via Job Form Filler Chrome Extension.
${profileKey ? `- Profile used: \`${profileKey}\`.\n` : ""}`;

  const jobPostingPath = path.join(appDir, "job-posting.md");
  fs.writeFileSync(jobPostingPath, jobPostingContent, "utf-8");

  // 2. Create cover-letter-<company>.md if cover letter provided
  let coverLetterPath = null;
  if (coverLetter && coverLetter.trim()) {
    coverLetterPath = path.join(appDir, `cover-letter-${companySlug}.md`);
    fs.writeFileSync(coverLetterPath, coverLetter.trim(), "utf-8");
  }

  return {
    success: true,
    savedPath: appDir,
    jobPostingPath,
    coverLetterPath
  };
}

module.exports = {
  saveApplication
};
