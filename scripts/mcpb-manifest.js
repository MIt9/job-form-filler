// Writes the Claude Desktop (MCPB) manifest into the staging dir. Usage: node scripts/mcpb-manifest.js <outDir>
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");

const tool = (name, description) => ({ name, description });

const manifest = {
  manifest_version: "0.3",
  name: "job-form-filler",
  display_name: "Job Form Filler",
  version: pkg.version,
  description: "Fills job application forms from your local profile via the Job Form Filler Chrome extension. Never clicks Submit.",
  long_description:
    "Connects Claude to the Job Form Filler Chrome extension. Standard fields are filled locally with zero tokens; " +
    "Claude only sees the remaining custom questions. Motivation questions are always left to you, and the final Submit " +
    "button is never clicked automatically. Install the extension from the Chrome Web Store first.",
  author: { name: "Dmytro Bilukha" },
  homepage: "https://github.com/MIt9/job-form-filler",
  repository: { type: "git", url: "https://github.com/MIt9/job-form-filler" },
  support: "https://github.com/MIt9/job-form-filler/issues",
  documentation: "https://github.com/MIt9/job-form-filler#readme",
  privacy_policies: ["https://github.com/MIt9/job-form-filler/blob/main/docs/PRIVACY.md"],
  license: "MIT",
  icon: "icon.png",
  keywords: ["jobs", "autofill", "chrome-extension", "applications"],
  server: {
    type: "node",
    entry_point: "bin/mcp.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/bin/mcp.js"],
      env: { RESUME_REPO_PATH: "${user_config.resume_dir}" }
    }
  },
  user_config: {
    resume_dir: {
      type: "directory",
      title: "Resume folder (optional)",
      description:
        "Folder with role-specific resumes (<folder>/<role>/*.md or *.pdf). Enables role variants and saving applications. Leave empty to use only the profile in the extension.",
      required: false
    }
  },
  tools: [
    tool("open_job_url", "Open a job application URL in Chrome."),
    tool("focus_tab", "Focus an already open application tab."),
    tool("get_job_posting", "Read a vacancy's full text without opening a tab."),
    tool("autofill_static_fields", "Fill contact/profile fields locally (0 tokens)."),
    tool("get_active_job_form", "List the still-empty questions of the open form."),
    tool("get_candidate_profile", "Read the candidate profile stored in the extension."),
    tool("fill_job_form", "Fill custom answers by field id."),
    tool("get_form_state", "Verify the current values in the form."),
    tool("click_button", "Click navigation buttons such as Continue (never Submit)."),
    tool("get_submission_status", "Check whether the application was submitted."),
    tool("update_candidate_profile", "Write facts into the extension profile."),
    tool("save_job_application", "Save an application to the resume folder."),
    tool("log_application", "Log a submitted or skipped application.")
  ],
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=18" } }
};

const out = path.resolve(process.argv[2] || ".");
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
