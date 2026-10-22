const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require("@modelcontextprotocol/sdk/types.js");

const { loadProfiles, DEFAULT_RESUME_REPO_PATH } = require("./profile-loader.js");
const { saveApplication } = require("./app-saver.js");
const { isHumanRequiredQuestion } = require("./human-questions.js");
const { getJobPosting } = require("./job-posting.js");
const { startBridgeServer } = require("./bridge-server.js");
const { logApplication } = require("./log-application.js");
const { PROFILE_FIELDS } = require("../extension/shared/default-profile.js");

const PROFILE_PATHS = PROFILE_FIELDS.filter((f) => f.path).map((f) => f.path);

const BRIDGE_PORT = process.env.BRIDGE_PORT || 8765;
const BRIDGE_HTTP_URL = `http://127.0.0.1:${BRIDGE_PORT}/api`;
// How long a call that just took the port over waits for the extension; its reconnect alarm fires every ~24s.
const EXTENSION_RECONNECT_WAIT_MS = 30000;

// This process's own bridge (initBridge). It stays unbound while another MCP client owns the port.
let bridge = null;
function initBridge() {
  bridge = startBridgeServer(); // logs go to stderr — stdout is the MCP protocol channel
  return bridge;
}

// The port owner (e.g. Claude Desktop) exited: bind the port ourselves, then give the extension time to reconnect.
async function takeOverBridgePort() {
  if (!bridge || bridge.server.listening) return false;
  const bound = await new Promise((resolve) => {
    const done = (ok) => { bridge.server.off("listening", onListening).off("error", onError); resolve(ok); };
    const onListening = () => done(true);
    const onError = () => done(false);
    bridge.server.once("listening", onListening).once("error", onError);
    bridge.server.listen(BRIDGE_PORT, "127.0.0.1");
  });
  if (!bound) return false;
  configWarning = undefined;
  console.error(`[JobFormFiller MCP] Took over bridge port ${BRIDGE_PORT}; waiting for the extension to reconnect`);
  for (const end = Date.now() + EXTENSION_RECONNECT_WAIT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    const status = await (await fetch(`${BRIDGE_HTTP_URL}/status`)).json().catch(() => ({}));
    if (status.extensionConnected) break;
  }
  return true;
}

const INSTRUCTIONS = `Fills job application forms in the user's Chrome via the Job Form Filler extension.
Step 0: open or focus the application form tab (via open_job_url or focus_tab); this server may open/focus tabs but never submits.
Workflow:
1. open_job_url or focus_tab — opens the application URL in Chrome or focuses an existing tab.
2. get_job_posting — reads a vacancy's full text, requirements, and questions without opening a tab; use it before drafting application answers.
3. autofill_static_fields — fills contact/profile fields locally (0 tokens). Report its missingProfile list to the user.
   If the profile is empty or missingProfile is long, offer to fill it with update_candidate_profile from the user's resume/LinkedIn — show the user the values first.
4. get_active_job_form — returns only the still-empty questions with stable fieldIds and options.
5. get_candidate_profile — the candidate's facts. Ground every answer in it; never invent numbers, tools or frequency claims.
6. fill_job_form — answers keyed by fieldId. For options, send one option text verbatim.
   Write free-text answers in the form's language (get_active_job_form.language); the profile's localized.<lang> holds the candidate's own spelling of names/cities in that language.
Questions flagged humanRequired (motivation, "tell us about a time", personal tradeoffs) must be answered by the user — ask, do not write them.
After autofill or fill_job_form, call get_form_state to verify what is really in the form (values, not just empty fields).
click_button only advances navigation (Continue/Next); the final Submit is always the user's click.
There is deliberately NO submit tool: the user reviews and clicks Submit. Afterwards get_submission_status confirms it.`;

/**
 * Sends a command to the already-running bridge-server process over HTTP.
 * mcp-server.js runs as its own OS process, so it cannot share bridge-server.js's
 * in-memory activeWsClient by require()-ing it — that state only exists in the
 * bridge-server process that actually accepted the extension's WebSocket connection.
 */
async function callBridge(command, payload = {}) {
  const post = () => fetch(`${BRIDGE_HTTP_URL}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, payload })
  });
  let res;
  try {
    res = await post();
  } catch {
    // Losing the takeover race to another client is fine: the retry then reaches that client's bridge.
    await takeOverBridgePort();
    try {
      res = await post();
    } catch (err) {
      throw new Error(`Bridge server is not running on ${BRIDGE_HTTP_URL}. Restart the MCP server (it starts the bridge itself). (${err.message})`);
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // Distinct case: bridge process is up but relayed a real error (e.g. no extension connected, or timeout).
    throw new Error(data.error || `Bridge request failed with status ${res.status}`);
  }
  return data.data ?? data;
}

const TOOLS = [
  {
    name: "open_job_url",
    description: "Opens a job application URL in a new active tab in Chrome, focuses the window, and waits for page load. Only http(s) URLs are allowed. Returns {tabId, windowId, url}.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Job application webpage URL (must be http or https)" }
      },
      required: ["url"]
    }
  },
  {
    name: "focus_tab",
    description: "Finds an existing tab in Chrome by tabId or URL substring match, activates it, and focuses its window. Returns {tabId, windowId, url, title}.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional Chrome tab ID to focus" },
        urlSubstring: { type: "string", description: "Optional substring to match against open tab URLs" }
      }
    }
  },
  {
    name: "get_job_posting",
    description: "Fetches and normalizes a job posting from any ATS (Ashby, Greenhouse, Lever, Workable) or HTML/JSON-LD; use summary:true when screening vacancies (small output); use default for application materials.Returns {source, url, title, company, location, remote, compensation, descriptionText, requirementsText, questions, fetchedAt}. Does not require an open tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Job posting URL (http/https only; aggregator links are resolved to the ATS page when possible)" },
        summary: { type: "boolean", description: "If true, return a small summary (title, company, location, remote, compensation, geoHints, requirementsText, questions) without descriptionText. Use when screening many vacancies; default false returns the full text for drafting application materials." }
      },
      required: ["url"]
    }
  },
  {
    name: "autofill_static_fields",
    description: "Instantly fills the active form's standard fields (name, contacts, links, location, work authorization, EEO, resume file...) from the profile stored in the extension. 0 tokens. Never overwrites non-empty fields. Waits while the page parses the uploaded resume and refills fields it wiped. Returns {filledCount, filled, missingProfile, failed, refilled}.",
    inputSchema: {
      type: "object",
      properties: {
        profileKey: { type: "string", description: "Optional role variant id (see get_candidate_profile.availableVariants)" }
      }
    }
  },
  {
    name: "get_active_job_form",
    description: "Reads the active Chrome tab: job title, company, form language (ISO 639-1), job description and the still-empty questions [{fieldId, label, type, required, options?, humanRequired?, profileKey?}]. By default trims description to 3000 chars; pass full=true to get full text (capped at 30000). profileKey means a standard field whose value is missing from the profile.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "If true, return full jobDescription (up to 30000 chars); otherwise trim to 3000." }
      }
    }
  },
  {
    name: "fill_job_form",
    description: "Writes answers into the active form, keyed by fieldId (label also works). Handles text, select, radio, checkbox, comboboxes and Yes/No toggles. Never submits. Returns {aiFilledCount, failed, notFound}.",
    inputSchema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          description: "Map of fieldId to answer text",
          additionalProperties: { type: "string" }
        }
      },
      required: ["answers"]
    }
  },
  {
    name: "get_candidate_profile",
    description: "Returns the candidate profile from the extension (contacts, links, work, legal) plus the selected role variant's resume markdown when a resume repo is configured (RESUME_REPO_PATH). The resume is the only source of experience facts.",
    inputSchema: {
      type: "object",
      properties: {
        profileKey: { type: "string", description: "Optional role variant id; defaults to the one selected in the popup" }
      }
    }
  },
  {
    name: "update_candidate_profile",
    description: `Writes candidate data into the extension profile (what autofill uses), so the user doesn't type it by hand. Use only facts the user gave or that are in their resume; show the user what you will set before calling. Existing values are kept unless overwrite=true; they come back as conflicts. Returns {changed, conflicts, ignored}. Allowed paths: ${PROFILE_PATHS.join(", ")}, profiles.<roleId>.title|summary. Legal fields take "Yes"/"No"; empty EEO fields mean "decline to self-identify".`,
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          description: 'Partial profile, e.g. {"personal": {"firstName": "Jane", "city": "Kyiv"}, "links": {"github": "https://github.com/jane"}}'
        },
        overwrite: { type: "boolean", description: "Replace existing non-empty values (only after the user confirmed)" }
      },
      required: ["patch"]
    }
  },
  {
    name: "save_job_application",
    description: "Saves the job posting (and an optional cover letter) as markdown into the role folder's applications/<company>/ (or ~/.job-form-filler/applications/<company>/). Use log_application to record the outcome (submitted or skipped) in the resume repo's job applications log.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "Company name" },
        jobTitle: { type: "string", description: "Job title" },
        profileKey: { type: "string", description: "Role variant id" },
        url: { type: "string", description: "Job URL" },
        jobDescription: { type: "string", description: "Job description markdown or clean text" },
        coverLetter: { type: "string", description: "Cover letter text" }
      },
      required: ["company"]
    }
  },
  {
    name: "log_application",
    description: "Records a job application outcome (submitted or skipped) into the resume repo. Idempotent: logs by URL or company+date. Updates info/applications-log.md with the outcome, and for submitted applications also updates the profile resume's Applications section and creates a job-posting.md file. Returns {logFile, rowOrBlock (inserted text), profileResume, applicationFolder, created (array), alreadyLogged, dryRun preview}. Set dryRun:true to preview changes without writing.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "Company name" },
        role: { type: "string", description: "Job title/role" },
        profile: { type: "string", description: "Resume profile folder name (e.g. 'ai-engineering-lead')" },
        url: { type: "string", description: "Job URL (http/https)" },
        status: { type: "string", enum: ["submitted", "skipped"], description: "Application outcome" },
        notes: { type: "string", description: "Optional notes/reason" },
        date: { type: "string", description: "ISO date (default: today)" },
        jobPostingText: { type: "string", description: "Markdown job posting to store (used if provided)" },
        fetchPosting: { type: "boolean", description: "If true and url is given, fetch and store the job posting" },
        dryRun: { type: "boolean", description: "If true, show what would be written without writing" }
      },
      required: ["company", "role", "profile", "status"]
    }
  },
  {
    name: "click_button",
    description: "Advances a multi-step form by clicking a NAVIGATION button. The label must exactly equal an allowed one (Continue, Next, Save and continue, Start application, Apply Now, Продовжити, Далі, ...); anything else is refused, and so is a matching button that also looks like Submit/Send/Apply/Confirm/Finish/Delete/Pay. It never submits: the user clicks the final Submit. Returns {success, clicked?, denied?, reason?, allowed?}.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Exact navigation label to click (e.g. \"Continue\", \"Next\", \"Apply Now\", \"Продовжити\")" }
      },
      required: ["text"]
    }
  },
  {
    name: "get_submission_status",
    description: "After the user clicks Submit: checks the URL (/confirm, /applied, /thank-you, /connect/dashboard ...) and the page text/banner for a confirmation. Returns {isSubmitted, matchedBy: \"url\"|\"text\"|null, headline, url, headings} without rescanning the form.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_form_state",
    description: "Every field of the application form with its CURRENT value (filled and empty), unlike get_active_job_form which lists only empty fields. Use it after autofill / fill_job_form to verify what is really in the form (a page may re-parse the resume and wipe fields). Returns [{fieldId, label, type, required, filled, value}]; passwords are masked, files show file names, checkbox/radio groups list the checked option labels.",
    inputSchema: {
      type: "object",
      properties: {
        maxValueLength: { type: "number", description: "Max characters per value (default 120)" },
        includeEmpty: { type: "boolean", description: "Include empty fields (default true)" }
      }
    }
  }
];

async function getCandidateProfile(profileKey) {
  const { candidateData, activeProfileKey, resumeFileName } = await callBridge("GET_PROFILE");
  const repo = loadProfiles();
  const key = profileKey || activeProfileKey;
  const variant = repo.profiles[key] || candidateData?.profiles?.[key] || null;
  return {
    candidate: candidateData,
    resumeFileName,
    activeVariant: key || null,
    availableVariants: [...new Set([...repo.availableProfiles, ...Object.keys(candidateData?.profiles || {})])],
    resume: variant ? { title: variant.title, summary: variant.summary, markdown: variant.fullMarkdown } : null
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "open_job_url": {
      if (!args.url || typeof args.url !== "string") {
        throw new Error("url parameter is required");
      }
      try {
        const parsed = new URL(args.url.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(`Invalid URL protocol "${parsed.protocol}". Only http: and https: URLs are allowed.`);
        }
      } catch (err) {
        throw new Error(`Invalid URL: ${err.message}`);
      }
      return callBridge("OPEN_JOB_URL", { url: args.url.trim() });
    }
    case "focus_tab": {
      if (args.tabId == null && !args.urlSubstring) {
        throw new Error("Either tabId or urlSubstring must be provided");
      }
      return callBridge("FOCUS_TAB", { tabId: args.tabId, urlSubstring: args.urlSubstring });
    }
    case "get_job_posting": {
      if (!args.url || typeof args.url !== "string") {
        throw new Error("url parameter is required");
      }
      return getJobPosting(args.url, { summary: !!args.summary });
    }
    case "autofill_static_fields": {
      const result = await callBridge("AUTOFILL_STATIC", { profileKey: args.profileKey });
      if (result?.failed?.some((f) => f.key === "resumeFile")) {
        result.hint =
          "The resume was not attached. Tell the user to upload it once in the extension popup (Profile tab, PDF/DOCX up to 5 MB); " +
          "autofill then attaches it. Do not search the user's disk for resume files.";
      }
      return result;
    }
    case "get_active_job_form": {
      const form = await callBridge("GET_ACTIVE_FORM", { full: !!args.full });
      (form.questions || []).forEach((q) => {
        if (isHumanRequiredQuestion(q)) q.humanRequired = true;
      });
      return form;
    }
    case "fill_job_form":
      return callBridge("FILL_FORM", { answers: args.answers });
    case "get_form_state":
      return callBridge("GET_FORM_STATE", { maxValueLength: args.maxValueLength || 120, includeEmpty: args.includeEmpty !== false });
    case "click_button": {
      if (!args.text || typeof args.text !== "string") {
        throw new Error("text parameter is required");
      }
      return callBridge("CLICK_BUTTON", { text: args.text });
    }

    case "get_submission_status":
      return callBridge("GET_SUBMISSION_STATUS");
    case "update_candidate_profile":
      return callBridge("SET_PROFILE", { patch: args.patch, overwrite: !!args.overwrite });
    case "get_candidate_profile":
      return getCandidateProfile(args.profileKey);
    case "save_job_application":
      return saveApplication(args);
    case "log_application":
      return logApplication(args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// Another process may already own the bridge port (an older run, or another MCP client). We then talk to
// that bridge, which ignores OUR settings: warn when its resume folder differs from the one configured here.
// Reset when this process takes the port over (takeOverBridgePort).
let configWarning;
async function bridgeConfigWarning() {
  if (bridge && bridge.server.listening) return null;
  if (configWarning !== undefined) return configWarning;
  configWarning = null;
  try {
    const status = await (await fetch(`${BRIDGE_HTTP_URL}/status`)).json();
    const mine = DEFAULT_RESUME_REPO_PATH || "";
    if ((status.resumeRepoPath || "") !== mine) {
      configWarning =
        `The bridge on port ${BRIDGE_PORT} belongs to another MCP client (e.g. Claude Desktop) and uses resume folder ` +
        `"${status.resumeRepoPath || "(none)"}", not this client's "${mine || "(none)"}". ` +
        "Give both clients the same RESUME_REPO_PATH, or quit the other one: this client takes the port over on its next call.";
    }
  } catch {}
  return configWarning;
}

async function runMcpServer() {
  const server = new Server(
    { name: "job-form-filler-mcp", version: require("../package.json").version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args);
      const warning = await bridgeConfigWarning();
      if (warning && result && typeof result === "object" && !Array.isArray(result)) result.warning = warning;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `${name} failed: ${err.message}` }] };
    }
  });

  initBridge();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[JobFormFiller MCP] Server running on stdio");
}

module.exports = { runMcpServer, callTool, TOOLS, INSTRUCTIONS, initBridge, callBridge, bridgeConfigWarning };
