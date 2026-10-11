const fs = require("fs");
const os = require("os");
const path = require("path");

// Opt-in only: no guessed location, the user points RESUME_REPO_PATH at their own folder.
function resolveDefaultResumeRepoPath() {
  return process.env.RESUME_REPO_PATH || "";
}

// Optional: a folder of role-specific resumes. Personal/contact data never comes from here —
// it lives in the extension (popup Profile tab). Supported layouts:
//   <repo>/resume/<role>/*.md|*.pdf   or   <repo>/<role>/*.md|*.pdf
const DEFAULT_RESUME_REPO_PATH = resolveDefaultResumeRepoPath();
const DATA_DIR = process.env.JFF_DATA_DIR || path.join(os.homedir(), ".job-form-filler");

// Prefer files named like "resume*" / "cv*", else the first file with that extension.
function pickFile(dir, ext) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).sort();
  return files.find((f) => /^(resume|cv)/i.test(f)) || files[0] || null;
}

/**
 * Loads role variants (title, summary, full markdown, PDF path) from the resume repo.
 */
function loadProfiles(repoPath = DEFAULT_RESUME_REPO_PATH) {
  if (!repoPath) repoPath = DEFAULT_RESUME_REPO_PATH;
  const result = { repoPath, availableProfiles: [], profiles: {} };
  if (!repoPath || !fs.existsSync(repoPath)) return result;

  const nested = path.join(repoPath, "resume");
  const rolesDir = fs.existsSync(nested) ? nested : repoPath;
  result.rolesDir = rolesDir;

  const slugs = fs
    .readdirSync(rolesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((slug) => pickFile(path.join(rolesDir, slug), ".md") || pickFile(path.join(rolesDir, slug), ".pdf"));

  result.availableProfiles = slugs;

  slugs.forEach((slug) => {
    const folder = path.join(rolesDir, slug);
    const mdFile = pickFile(folder, ".md");
    const pdfFile = pickFile(folder, ".pdf");
    const fullMarkdown = mdFile ? fs.readFileSync(path.join(folder, mdFile), "utf-8") : "";

    let title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const titleMatch = fullMarkdown.match(/\*\*([^*]+)\*\*/);
    if (titleMatch) title = titleMatch[1].trim();
    const summaryMatch = fullMarkdown.match(/## Summary\s+([\s\S]*?)(?=---|\n## )/);

    result.profiles[slug] = {
      id: slug,
      title,
      summary: summaryMatch ? summaryMatch[1].trim() : "",
      fullMarkdown,
      path: folder,
      pdfPath: pdfFile ? path.join(folder, pdfFile) : null,
      pdfFileName: pdfFile
    };
  });

  return result;
}

module.exports = {
  loadProfiles,
  DEFAULT_RESUME_REPO_PATH,
  resolveDefaultResumeRepoPath,
  DATA_DIR
};
