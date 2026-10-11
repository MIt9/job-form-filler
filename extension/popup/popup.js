/**
 * Job Form Filler - Popup Controller
 */

document.addEventListener("DOMContentLoaded", async () => {
  // Elements
  const bridgeStatus = document.getElementById("bridge-status");
  const bridgeStatusText = document.getElementById("bridge-status-text");
  const detectedPlatform = document.getElementById("detected-platform");
  const detectedFieldsSummary = document.getElementById("detected-fields-summary");
  const detectedCompany = document.getElementById("detected-company");
  const detectedRole = document.getElementById("detected-role");
  const profileSelect = document.getElementById("profile-select");
  const actionMessage = document.getElementById("action-message");

  const btnAutofillStatic = document.getElementById("btn-autofill-static");
  const btnFillAi = document.getElementById("btn-fill-ai");
  const btnCopyPrompt = document.getElementById("btn-copy-prompt");
  const btnSaveRepo = document.getElementById("btn-save-repo");
  const btnReconnectBridge = document.getElementById("btn-reconnect-bridge");
  const btnLearnAnswers = document.getElementById("btn-learn-answers");
  const btnClearLearned = document.getElementById("btn-clear-learned");
  const learnedAnswersList = document.getElementById("learned-answers-list");
  const learnedCountEl = document.getElementById("learned-count");
  const profileForm = document.getElementById("profile-form");
  const resumeInput = document.getElementById("resume-input");
  const resumeStatus = document.getElementById("resume-status");
  const importInput = document.getElementById("import-input");
  const fillReport = document.getElementById("fill-report");
  const translationLang = document.getElementById("translation-lang");
  const translationForm = document.getElementById("translation-form");

  // i18n: _locales/<browser UI language>/messages.json, falling back to English (default_locale).
  const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
  const fieldLabel = (path) => chrome.i18n.getMessage(`field_${path.replace(/\./g, "_")}`) || profileFieldLabel(path);
  const uiLang = chrome.i18n.getUILanguage().slice(0, 2);
  document.documentElement.lang = uiLang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  // Only our own messages.json markup (<code>) goes through innerHTML, never page content.
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18nHtml);
    if (m) el.innerHTML = m;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (m) el.title = m;
  });

  // State
  let activeTab = null;
  let jobData = null;
  let candidateData = structuredClone(DEFAULT_CANDIDATE_DATA);
  let activeProfileKey = null;
  let bridgeProfiles = {};
  let isBridgeConnected = false;
  let learnedAnswers = {};

  // Initialize Tabs
  document.querySelectorAll(".jff-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".jff-tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".jff-tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      const tabId = btn.getAttribute("data-tab");
      document.getElementById(tabId)?.classList.add("active");
    });
  });

  // Load candidate data and learned answers from storage
  await new Promise((resolve) => {
    chrome.storage.local.get(["candidateData", "activeProfileKey", "learnedAnswers", "bridgeProfiles", "resumeFile"], (res) => {
      if (res.candidateData) candidateData = res.candidateData;
      if (res.activeProfileKey) activeProfileKey = res.activeProfileKey;
      if (res.bridgeProfiles) bridgeProfiles = res.bridgeProfiles;
      if (res.resumeFile) resumeStatus.textContent = t("resumeStatus", res.resumeFile.fileName);
      if (res.learnedAnswers) {
        learnedAnswers = res.learnedAnswers;
      }
      resolve();
    });
  });

  // Render learned answers in Profile tab
  function renderLearnedAnswers() {
    if (!learnedAnswersList) return;
    const entries = Object.entries(learnedAnswers);
    if (learnedCountEl) learnedCountEl.textContent = entries.length;

    if (entries.length === 0) {
      learnedAnswersList.innerHTML = `<div class="jff-empty-hint"></div>`;
      learnedAnswersList.firstChild.textContent = t("learnedEmpty");
      return;
    }

    learnedAnswersList.innerHTML = "";
    entries.forEach(([q, a]) => {
      // Questions/answers come from arbitrary web pages: build with textContent, never innerHTML.
      const item = document.createElement("div");
      item.className = "jff-learned-item";
      item.innerHTML = `
        <div class="jff-learned-content">
          <div class="jff-learned-q"></div>
          <div class="jff-learned-a"></div>
        </div>
        <button class="jff-learned-delete">&times;</button>
      `;
      const qEl = item.querySelector(".jff-learned-q");
      const aEl = item.querySelector(".jff-learned-a");
      qEl.textContent = qEl.title = q;
      aEl.textContent = `↳ ${a}`;
      aEl.title = a;
      item.querySelector(".jff-learned-delete").dataset.q = encodeURIComponent(q);
      item.querySelector(".jff-learned-delete").title = t("deleteTip");
      learnedAnswersList.appendChild(item);
    });

    // Delete buttons
    learnedAnswersList.querySelectorAll(".jff-learned-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const qToDelete = decodeURIComponent(btn.getAttribute("data-q"));
        delete learnedAnswers[qToDelete];
        chrome.storage.local.set({ learnedAnswers });
        renderLearnedAnswers();
        broadcastLearnedAnswers();
      });
    });
  }

  function broadcastLearnedAnswers() {
    if (activeTab?.id) {
      broadcastToAllFrames(activeTab, {
        action: "UPDATE_PROFILE",
        activeProfileKey,
        candidateData,
        learnedAnswers
      }).catch(() => {});
    }
  }

  // Profile editor, rendered from PROFILE_FIELDS (shared/default-profile.js). Inputs write into
  // `draft`; Save persists it. Switching the translation language therefore loses nothing.
  let draft = structuredClone(candidateData);

  function profileInput(f, path) {
    let input;
    if (f.options) {
      input = document.createElement("select");
      f.options.forEach((o) => input.add(new Option(o ? t(o.toLowerCase()) : "—", o)));
    } else {
      input = document.createElement("input");
      input.type = f.type || "text";
      input.placeholder = (f.path.startsWith("eeo.") && chrome.i18n.getMessage("ph_decline")) || f.placeholder || "";
    }
    input.id = `prof-${path}`;
    input.className = "jff-input-sm";
    const v = getPath(draft, path);
    input.value = v === true ? "Yes" : v === false ? "No" : v ?? "";
    input.addEventListener("input", () => setPath(draft, path, input.value.trim()));
    return input;
  }

  function addRow(container, text, input) {
    const label = document.createElement("label");
    label.className = "jff-label-sm";
    label.textContent = text;
    label.htmlFor = input.id;
    container.append(label, input);
  }

  function renderProfileForm() {
    profileForm.innerHTML = "";
    PROFILE_FIELDS.forEach((f) => {
      if (f.section) {
        const h = document.createElement("div");
        h.className = "jff-form-section";
        h.textContent = chrome.i18n.getMessage(`section_${f.section}`) || f.label;
        profileForm.appendChild(h);
        return;
      }
      addRow(profileForm, fieldLabel(f.path), profileInput(f, f.path));
    });
    renderTranslationForm();
  }

  // Per-language values (localized.<lang>.<path>); the placeholder shows the value being translated.
  function renderTranslationForm() {
    const lang = translationLang.value;
    translationForm.innerHTML = "";
    PROFILE_FIELDS.filter((f) => f.translatable).forEach((f) => {
      const input = profileInput(f, `localized.${lang}.${f.path}`);
      input.placeholder = getPath(draft, f.path) || "";
      addRow(translationForm, fieldLabel(f.path), input);
    });
  }

  Object.entries(FORM_LANGUAGES).forEach(([code, name]) => translationLang.add(new Option(name, code)));
  translationLang.value = FORM_LANGUAGES[uiLang] && uiLang !== "en" ? uiLang : "uk";
  translationLang.addEventListener("change", renderTranslationForm);

  function isProfileEmpty() {
    return !candidateData?.personal?.email && !candidateData?.personal?.firstName;
  }

  function refreshProfileUI() {
    draft = structuredClone(candidateData);
    renderProfileForm();
    renderProfileSelect();
    document.getElementById("profile-empty-hint").classList.toggle("hidden", !isProfileEmpty());
  }

  async function saveProfile(data) {
    candidateData = data;
    await chrome.storage.local.set({ candidateData });
    refreshProfileUI();
    broadcastLearnedAnswers();
  }

  document.getElementById("btn-save-profile").addEventListener("click", async () => {
    await saveProfile(structuredClone(draft));
    showMessage(t("profileSaved"), "success");
  });

  document.getElementById("btn-export-profile").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(candidateData, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "job-form-filler-profile.json";
    link.click();
  });

  document.getElementById("btn-import-profile").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (typeof data !== "object" || Array.isArray(data) || !data) throw new Error(t("expectedObject"));
      await saveProfile({ ...structuredClone(DEFAULT_CANDIDATE_DATA), ...data });
      showMessage(t("profileImported"), "success");
    } catch (e) {
      showMessage(t("profileInvalidJson", e.message), "error");
    }
    importInput.value = "";
  });

  resumeInput.addEventListener("change", async () => {
    const file = resumeInput.files[0];
    if (!file) return;
    // chrome.storage.local quota is 10 MB; base64 adds ~33%.
    if (file.size > 5 * 1024 * 1024) {
      showMessage(t("resumeTooBig"), "error");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await chrome.storage.local.set({
      resumeFile: { fileName: file.name, mimeType: file.type || "application/pdf", base64: btoa(binary) }
    });
    resumeStatus.textContent = t("resumeStatus", file.name);
    showMessage(t("resumeSaved"), "success");
  });

  // Role variants: from the profile JSON (`profiles`) plus the bridge's resume repo, if any.
  function renderProfileSelect() {
    const variants = { ...bridgeProfiles, ...(candidateData?.profiles || {}) };
    const ids = Object.keys(variants);
    document.getElementById("profile-select-section").classList.toggle("hidden", ids.length === 0);
    profileSelect.innerHTML = "";
    ids.forEach((id) => profileSelect.add(new Option(variants[id].title || id, id)));
    if (ids.length && !ids.includes(activeProfileKey)) {
      activeProfileKey = ids[0];
      chrome.storage.local.set({ activeProfileKey });
    }
    profileSelect.value = activeProfileKey || "";
  }

  refreshProfileUI();

  profileSelect.addEventListener("change", () => {
    activeProfileKey = profileSelect.value;
    chrome.storage.local.set({ activeProfileKey });
    broadcastLearnedAnswers();
    showMessage(t("activeVariant", profileSelect.options[profileSelect.selectedIndex].text), "info");
  });

  function showFillReport(lines) {
    fillReport.textContent = lines.filter(Boolean).join("\n");
    fillReport.classList.toggle("hidden", !fillReport.textContent);
  }

  // Check Local Bridge Status
  async function checkBridge() {
    try {
      const res = await fetch("http://127.0.0.1:8765/api/status", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        isBridgeConnected = true;
        bridgeStatus.className = "jff-status-badge connected";
        bridgeStatusText.textContent = t("bridgeOnline");
        return true;
      }
    } catch (e) {}

    isBridgeConnected = false;
    bridgeStatus.className = "jff-status-badge";
    bridgeStatusText.textContent = t("bridgeOffline");
    return false;
  }

  await checkBridge();

  btnReconnectBridge.addEventListener("click", async () => {
    btnReconnectBridge.textContent = t("checking");
    const ok = await checkBridge();
    btnReconnectBridge.textContent = t("btnReconnect");
    if (ok) {
      showMessage(t("bridgeConnected"), "success");
    } else {
      showMessage(t("bridgeOfflineHint"), "error");
    }
  });

  // Helper: Ensure content script is injected even on pre-existing tabs
  async function ensureContentScriptInjected(tab) {
    if (!tab || !tab.id) return false;

    const url = tab.url || "";
    if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://") || url.startsWith("view-source:") || url.startsWith("about:")) {
      throw new Error(t("systemPage"));
    }

    const isAlive = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: "PING" }, (res) => {
        if (chrome.runtime.lastError || !res?.pong) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (isAlive) return true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["shared/default-profile.js", "content/form-helpers.js", "content/content.js"]
      });

      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: true },
          files: ["content/content.css"]
        });
      } catch (cssErr) {}

      await new Promise((r) => setTimeout(r, 200));
      return true;
    } catch (err) {
      throw new Error(t("injectFailed", err.message));
    }
  }

  // Broadcast message to all frames in the tab (necessary for embedded ATS iframes)
  async function broadcastToAllFrames(tab, message) {
    await ensureContentScriptInjected(tab);

    let frameIds = [0];
    try {
      if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        if (frames && frames.length > 0) {
          frameIds = frames.map((f) => f.frameId);
        }
      }
    } catch (e) {}

    const settled = await Promise.allSettled(
      frameIds.map((frameId) => {
        return new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, message, { frameId }, (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(res);
            }
          });
        });
      })
    );

    return settled
      .filter((s) => s.status === "fulfilled" && s.value)
      .map((s) => s.value);
  }

  // Query Active Tab & Detect Form
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];

    if (activeTab && activeTab.id) {
      try {
        const results = await broadcastToAllFrames(activeTab, { action: "GET_JOB_AND_QUESTIONS" });
        if (!results || results.length === 0) {
          detectedPlatform.textContent = t("formNotFound");
          detectedCompany.textContent = "—";
          detectedRole.textContent = t("goToApplication");
          detectedFieldsSummary.textContent = t("fieldsZero");
        } else {
          // Merge results from all frames
          const merged = {
            platform: results.find((r) => r.platform && r.platform !== "Generic Job Board")?.platform || results[0].platform,
            company: results.find((r) => r.company && r.company !== "Www")?.company || results[0].company,
            jobTitle: results.find((r) => r.jobTitle)?.jobTitle || activeTab.title,
            jobDescription: results.find((r) => r.jobDescription)?.jobDescription || "",
            language: (results.find((r) => r.questions?.length) || results[0]).language,
            questions: results.flatMap((r) => r.questions || []),
            totalFieldsCount: results.reduce((acc, r) => acc + (r.totalFieldsCount || 0), 0),
            staticFilledCount: results.reduce((acc, r) => acc + (r.staticFilledCount || 0), 0),
            url: activeTab.url
          };

          jobData = merged;
          detectedPlatform.textContent = merged.platform || "Job Board";
          detectedCompany.textContent = merged.company || t("companyFallback");
          detectedRole.textContent = merged.jobTitle || activeTab.title;

          const total = merged.totalFieldsCount;
          const dyn = merged.questions.length;
          const staticCount = total - dyn;
          detectedFieldsSummary.textContent = t("fieldsSummary", total, staticCount, dyn);
        }
      } catch (tabErr) {
        detectedPlatform.textContent = t("readyToRun");
        detectedRole.textContent = activeTab.title || t("jobPage");
      }
    }
  } catch (err) {
    console.error("Error detecting active tab:", err);
  }

  // 1. Autofill Static Fields (0 tokens)
  btnAutofillStatic.addEventListener("click", async () => {
    if (!activeTab?.id) return;

    showMessage(t("filling"), "info");
    try {
      const results = await broadcastToAllFrames(activeTab, {
        action: "AUTOFILL_STATIC",
        candidateData,
        activeProfileKey
      });

      const totalFilled = results.reduce((acc, r) => acc + (r.filledCount || 0), 0);
      const labels = (k) => [...new Set(results.flatMap((r) => (r[k] || []).map((e) => e.label || e.key)))];
      const missing = labels("missingProfile");
      const failed = labels("failed");
      showFillReport([
        results[0]?.language && t("formLanguage", FORM_LANGUAGES[results[0].language] || results[0].language),
        missing.length && t("missingInProfile", missing.join(", ")),
        failed.length && t("couldNotFill", failed.join(", "))
      ]);
      if (totalFilled > 0) {
        showMessage(t("filledN", totalFilled), "success");
      } else {
        showMessage(t("filledZero"), "error");
      }
    } catch (err) {
      showMessage(t("pageAccessError", err.message), "error");
    }
  });

  // 2. Fill with AI via Bridge
  btnFillAi.addEventListener("click", async () => {
    if (!activeTab?.id) return;
    if (!jobData || !jobData.questions || jobData.questions.length === 0) {
      try {
        const recheckResults = await broadcastToAllFrames(activeTab, { action: "GET_JOB_AND_QUESTIONS" });
        if (recheckResults && recheckResults.length > 0) {
          jobData = {
            platform: recheckResults.find((r) => r.platform)?.platform,
            company: recheckResults.find((r) => r.company)?.company,
            jobTitle: recheckResults.find((r) => r.jobTitle)?.jobTitle,
            jobDescription: recheckResults.find((r) => r.jobDescription)?.jobDescription || "",
            language: (recheckResults.find((r) => r.questions?.length) || recheckResults[0]).language,
            questions: recheckResults.flatMap((r) => r.questions || [])
          };
        }
      } catch (e) {}
    }

    if (!jobData || !jobData.questions || jobData.questions.length === 0) {
      showMessage(t("noCustomQuestions"), "info");
      return;
    }

    if (!isBridgeConnected) {
      showMessage(t("bridgeNotRunning"), "error");
      return;
    }

    showMessage(t("generating"), "info");

    try {
      const response = await fetch("http://127.0.0.1:8765/api/generate-answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobTitle: jobData.jobTitle,
          company: jobData.company,
          jobDescription: jobData.jobDescription,
          profileKey: activeProfileKey,
          candidateData,
          language: jobData.language,
          questions: jobData.questions
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const result = await response.json();
      if (result.answers) {
        const injectResults = await broadcastToAllFrames(activeTab, {
          action: "INJECT_AI_ANSWERS",
          answers: result.answers
        });
        const totalAi = injectResults.reduce((acc, r) => acc + (r.aiFilledCount || 0), 0);
        const list = (qs) => (qs || []).map((q) => `• ${q.label}`).join("\n");
        showFillReport([
          result.humanRequiredQuestions?.length && t("needYourAnswer", list(result.humanRequiredQuestions)),
          result.unansweredQuestions?.length && t("unanswered", list(result.unansweredQuestions))
        ]);
        if (totalAi > 0) {
          showMessage(t("aiFilledN", totalAi), "success");
        } else {
          showMessage(t("answersNoFields"), "error");
        }
      } else {
        showMessage(t("serverNoAnswers"), "error");
      }
    } catch (err) {
      showMessage(t("bridgeGenError", err.message), "error");
    }
  });

  // 3. Copy Compact Prompt for CLI (Claude Code / AGY)
  btnCopyPrompt.addEventListener("click", () => {
    if (!jobData) {
      showMessage(t("openJobFirst"), "error");
      return;
    }

    const promptText = buildMinimalPrompt(jobData, activeProfileKey, candidateData);
    navigator.clipboard.writeText(promptText).then(() => {
      showMessage(t("promptCopied"), "success");
    }).catch((e) => {
      showMessage(t("copyFailed", e.message), "error");
    });
  });

  // 4. Save to Repo
  btnSaveRepo.addEventListener("click", async () => {
    if (!jobData) {
      showMessage(t("jobNotFound"), "error");
      return;
    }

    if (!isBridgeConnected) {
      showMessage(t("repoNeedsBridge"), "error");
      return;
    }

    showMessage(t("savingToRepo"), "info");

    try {
      const res = await fetch("http://127.0.0.1:8765/api/save-application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileKey: activeProfileKey,
          company: jobData.company,
          jobTitle: jobData.jobTitle,
          url: jobData.url,
          jobDescription: jobData.jobDescription
        })
      });

      const resData = await res.json();
      if (res.ok && resData.success) {
        showMessage(t("savedTo", resData.savedPath), "success");
      } else {
        showMessage(t("errorPrefix", resData.error || t("saveFailed")), "error");
      }
    } catch (err) {
      showMessage(t("bridgeError", err.message), "error");
    }
  });

  // 5. Learn Answers from Form (Self-Learning Profile)
  btnLearnAnswers.addEventListener("click", async () => {
    if (!activeTab?.id) {
      showMessage(t("noActiveTab"), "error");
      return;
    }

    showMessage(t("readingAnswers"), "info");

    try {
      const results = await broadcastToAllFrames(activeTab, { action: "EXTRACT_CURRENT_ANSWERS" });
      const extracted = {};
      let merged = { data: candidateData, changed: [], conflicts: [] };

      results.forEach((r) => {
        if (r?.answers) Object.assign(extracted, r.answers);
        // Standard fields go into the profile, but only into empty slots: the editor stays authoritative.
        if (r?.profilePatch) {
          const m = mergeProfile(merged.data, r.profilePatch);
          let { data, changed, conflicts } = m;
          // On a non-English form a differing value is usually a translation ("Дмитро" vs "Dmytro"):
          // store it as localized.<lang> instead of reporting a conflict.
          if (r.language && r.language !== "en" && conflicts.length) {
            const localPatch = {};
            conflicts.forEach((c) => setPath(localPatch, `localized.${r.language}.${c.path}`, c.proposed));
            const l = mergeProfile(data, localPatch);
            const translated = new Set(l.changed.map((p) => p.replace(/^localized\.[a-z]{2}\./, "")));
            data = l.data;
            changed = [...changed, ...l.changed];
            conflicts = conflicts.filter((c) => !translated.has(c.path));
          }
          merged = { data, changed: [...merged.changed, ...changed], conflicts: [...merged.conflicts, ...conflicts] };
        }
      });

      const keys = Object.keys(extracted);
      if (keys.length === 0 && merged.changed.length === 0 && merged.conflicts.length === 0) {
        showMessage(t("nothingToSave"), "error");
        return;
      }

      if (merged.changed.length) await saveProfile(merged.data);
      showFillReport([
        merged.changed.length && t("addedToProfile", merged.changed.map((p) => {
          const local = p.match(/^localized\.([a-z]{2})\.(.+)$/);
          return local ? `${fieldLabel(local[2])} (${local[1]})` : fieldLabel(p);
        }).join(", ")),
        merged.conflicts.length &&
          t("differsFromProfile", merged.conflicts.map((c) => `• ${fieldLabel(c.path)}: «${c.current}» → «${c.proposed}»`).join("\n"))
      ]);

      if (keys.length) {
        learnedAnswers = { ...learnedAnswers, ...extracted };
        chrome.storage.local.set({ learnedAnswers });
        renderLearnedAnswers();
        broadcastLearnedAnswers();

        // Sync to Bridge if connected
        if (isBridgeConnected) {
          try {
            await fetch("http://127.0.0.1:8765/api/learned-answers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ answers: learnedAnswers })
            });
          } catch (syncErr) {
            console.warn("Failed to sync learned answers to bridge:", syncErr);
          }
        }
      }

      showMessage(t("learnedSummary", merged.changed.length, keys.length), "success");
    } catch (err) {
      showMessage(t("saveError", err.message), "error");
    }
  });

  // Clear all learned answers
  btnClearLearned.addEventListener("click", () => {
    if (confirm(t("confirmClear"))) {
      learnedAnswers = {};
      chrome.storage.local.set({ learnedAnswers });
      renderLearnedAnswers();
      broadcastLearnedAnswers();
      if (isBridgeConnected) {
        fetch("http://127.0.0.1:8765/api/learned-answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: {} })
        }).catch(() => {});
      }
      showMessage(t("learnedCleared"), "info");
    }
  });

  // Fetch initial learned answers from bridge if available
  async function syncLearnedFromBridge() {
    if (!isBridgeConnected) return;
    try {
      const res = await fetch("http://127.0.0.1:8765/api/learned-answers");
      if (res.ok) {
        const data = await res.json();
        if (data.answers && Object.keys(data.answers).length > 0) {
          learnedAnswers = { ...data.answers, ...learnedAnswers };
          chrome.storage.local.set({ learnedAnswers });
          renderLearnedAnswers();
          broadcastLearnedAnswers();
        }
      }
    } catch (e) {}
  }

  renderLearnedAnswers();
  syncLearnedFromBridge();

  // Helper: Build Minimal Prompt for CLI
  function buildMinimalPrompt(job, profileKey, candidate) {
    const profileTitle = candidate?.profiles?.[profileKey]?.title || profileKey;
    const profileSummary = candidate?.profiles?.[profileKey]?.summary || "";

    const questionsList = (job.questions || [])
      .map((q, idx) => `${idx + 1}. [${q.fieldId}] "${q.label}" (Type: ${q.type}${q.required ? ', Required' : ''})${q.options?.length ? ` Options: ${q.options.join(" / ")}` : ""}`)
      .join("\n");

    return `Please generate tailored answers for this job application.

Target Profile: ${profileTitle}
Profile Summary: ${profileSummary}
Company: ${job.company}
Role: ${job.jobTitle}
URL: ${job.url}

Job Requirements Summary:
${job.jobDescription.slice(0, 1500)}

Questions to Answer:
${questionsList}

Answer language: ${job.language || "en"} (write every answer in this language).
Output Format: Return strictly a valid JSON object where keys are the [fieldId] and values are the answer text. Never invent facts not grounded in the candidate's profile.
Example:
{
  "${job.questions?.[0]?.fieldId || 'field_1'}": "Answer text..."
}`;
  }

  // Helper: Show UI Message
  function showMessage(text, type = "info") {
    actionMessage.className = `jff-message ${type}`;
    actionMessage.textContent = text;
    actionMessage.classList.remove("hidden");
    setTimeout(() => {
      actionMessage.classList.add("hidden");
    }, 6000);
  }
});
