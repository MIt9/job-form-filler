/**
 * Job Form Filler - Content Script
 * Handles form detection, 0-token static autofill, and AI dynamic response injection.
 */

(function () {
  // Prevent duplicate execution
  if (window.__JFF_INITIALIZED__) return;
  window.__JFF_INITIALIZED__ = true;

  console.log("[Job Form Filler] Content script active");

  // Shared helpers (content/form-helpers.js is loaded before this file; require() in tests).
  const H =
    globalThis.__JFF_HELPERS ||
    (typeof require !== "undefined" ? require("./form-helpers.js") : null) || {
      fhIsNoise: () => false,
      fhGetApplicationScope: () => null,
      fhClassifyFileInput: () => ({ passed: false, weak: true, reason: "helpers unavailable" }),
      fhSubmissionByUrl: () => false,
      fhPickLabel: () => null
    };

  // State
  let candidateData = null;
  let activeProfileKey = null;
  let learnedAnswers = {};

  // Normalizes question label for fuzzy comparison
  function normalizeQuestion(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function findLearnedAnswer(fullIdOrLabel) {
    if (!learnedAnswers || Object.keys(learnedAnswers).length === 0) return null;
    const targetNorm = normalizeQuestion(fullIdOrLabel);
    if (!targetNorm) return null;

    for (const [savedQ, savedAns] of Object.entries(learnedAnswers)) {
      const savedNorm = normalizeQuestion(savedQ);
      if (savedNorm.length > 3 && (targetNorm.includes(savedNorm) || savedNorm.includes(targetNorm))) {
        return savedAns;
      }
    }
    return null;
  }

  // Load initial candidate data and learned answers from chrome.storage
  function loadCandidateData(callback) {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["candidateData", "activeProfileKey", "learnedAnswers"], (res) => {
        if (res.candidateData) {
          candidateData = res.candidateData;
        } else if (typeof DEFAULT_CANDIDATE_DATA !== "undefined") {
          candidateData = DEFAULT_CANDIDATE_DATA;
        }
        if (res.activeProfileKey) {
          activeProfileKey = res.activeProfileKey;
        }
        if (res.learnedAnswers) {
          learnedAnswers = res.learnedAnswers;
        }
        if (callback) callback();
      });
    } else if (typeof DEFAULT_CANDIDATE_DATA !== "undefined") {
      candidateData = DEFAULT_CANDIDATE_DATA;
      if (callback) callback();
    }
  }

  loadCandidateData();

  // Helper: Human-like value insertion using browser's native insertText (bypasses bot detectors)
  function setHumanLikeValue(element, value) {
    if (!element || value === undefined || value === null) return;
    replaceFieldValue(element, value);
  }

  // Helper: Clear field value and set new value (fixes concatenation bug)
  // Exported for testing when module.exports exists (test context).
  function replaceFieldValue(element, value) {
    if (!element || value === undefined || value === null) return;

    // For text-like fields, explicitly clear first to prevent concatenation
    if (element.tagName !== "SELECT" && element.type !== "checkbox" && element.type !== "radio" && element.type !== "file") {
      // Clear the field completely before setting new value
      element.focus();
      // Use select() + delete to ensure full clear
      if (element.select) {
        element.select();
        document.execCommand && document.execCommand("delete"); // Delete selected content
      }
      // Also clear via property setter in case select/delete failed
      const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
      const prototype = Object.getPrototypeOf(element);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, "");
      } else if (valueSetter) {
        valueSetter.call(element, "");
      } else {
        element.value = "";
      }
    }

    // Now set the new value
    element.focus();
    element.dispatchEvent(new Event("focus", { bubbles: true }));

    // Try native document.execCommand('insertText') which produces trusted browser input events
    let inserted = false;
    try {
      element.select?.();
      inserted = document.execCommand && document.execCommand("insertText", false, String(value));
    } catch (e) {}

    // Fallback to property setter if execCommand failed
    if (!inserted || String(element.value ?? "") !== String(value)) {
      const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
      const prototype = Object.getPrototypeOf(element);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
      } else if (valueSetter) {
        valueSetter.call(element, value);
      } else {
        element.value = value;
      }
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));

    // Subtle stealth highlight without detectable bot classes
    element.setAttribute("data-autofill-highlight", "1");
  }

  // Helper: Robust click dispatch simulating full user pointer/mouse cycle for React/MUI
  function dispatchUserClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // Helper: Select option in Material-UI / custom Combobox & Autocomplete dropdowns
  // Helper: Select option in Material-UI / custom Combobox & Autocomplete dropdowns
  // ITEM A FIX: Snapshot neighboring fields to detect/prevent text corruption
  // ITEM B FIX: Timeout protection and cap iterations on huge lists (3000+ cities)
  async function selectComboboxOption(inputEl, targetValue) {
    if (!inputEl || !targetValue) return false;

    const targetNorm = targetValue.toLowerCase().trim();
    const isDialCode = /^\+?\d+$/.test(targetNorm);

    // If input is readonly, temporarily remove it so typing/execCommand works for filtering
    const wasReadOnly = inputEl.readOnly;
    if (wasReadOnly) {
      try { inputEl.readOnly = false; } catch (e) {}
    }

    // 1. Focus and open the dropdown popup
    inputEl.focus();
    dispatchUserClick(inputEl);

    // Also click parent container or open button if present (MUI Autocomplete arrow button)
    const arrowBtn = inputEl.parentElement?.querySelector('button[aria-label*="open" i], button[title*="Open" i], .MuiAutocomplete-popupIndicator');
    if (arrowBtn) dispatchUserClick(arrowBtn);

    // If there's an inner input inside the element or its parent
    // Scope strictly to inputEl's OWN subtree — a parent-level fallback here can grab an
    // unrelated sibling field's <input> (e.g. a nearby address/link field), corrupting it.
    let activeInput = inputEl;
    if (inputEl.tagName.toLowerCase() !== "input") {
      const childInput = inputEl.querySelector("input");
      if (childInput) activeInput = childInput;
    }

    // ITEM A FIX: Snapshot other form fields before typing to detect corruption
    const fieldSnapshots = new Map();
    const applicationScope = H.fhGetApplicationScope(document);
    const scopeEl = applicationScope || document.body;
    Array.from(scopeEl.querySelectorAll("input, textarea")).forEach((el) => {
      if (el !== activeInput && el !== inputEl && !el.hidden) {
        fieldSnapshots.set(el, el.value);
      }
    });

    // 2. Set typed value to filter list — ITEM A: Explicitly focus and verify before insertText
    activeInput.focus();
    if (document.activeElement !== activeInput) {
      // Focus didn't stick — use fallback property setter instead of insertText
      const valueSetter = Object.getOwnPropertyDescriptor(activeInput, "value")?.set;
      const prototype = Object.getPrototypeOf(activeInput);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(activeInput, targetValue);
      } else if (valueSetter) {
        valueSetter.call(activeInput, targetValue);
      } else {
        activeInput.value = targetValue;
      }
      activeInput.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setHumanLikeValue(activeInput, targetValue);
    }
    activeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", keyCode: 40, bubbles: true }));

    // ITEM A FIX: After value insertion, verify no other fields were corrupted
    const corruptedFields = [];
    fieldSnapshots.forEach((originalValue, el) => {
      if (el.value !== originalValue) {
        corruptedFields.push({ el, originalValue });
      }
    });
    // Restore any corrupted fields
    corruptedFields.forEach(({ el, originalValue }) => {
      el.value = originalValue;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Helper: Wait for options to populate after async debounced fetch (e.g. Toggl "Loading..." suggestions)
    // ITEM B FIX: Reduced timeout and time-boxed iteration
    async function waitForOptions(timeoutMs = 1500) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        const listboxId = activeInput.getAttribute("aria-controls") || activeInput.getAttribute("aria-owns") || inputEl.getAttribute("aria-controls");
        const listbox = listboxId ? document.getElementById(listboxId) : document.querySelector('[role="listbox"], .MuiAutocomplete-listbox, .MuiMenu-list');
        // Scope the portal search box to THIS field's own popper/dialog ancestor (found via the
        // listbox we just resolved) — a page-wide document.querySelector here can hijack an
        // unrelated empty input elsewhere on the page (e.g. a not-yet-filled field).
        const popperRoot = listbox?.closest('[role="dialog"], [role="presentation"], .MuiAutocomplete-popper');
        const searchBoxInPortal = popperRoot?.querySelector('input[type="text"]') || null;

        if (searchBoxInPortal && searchBoxInPortal !== activeInput && !searchBoxInPortal.value) {
          setHumanLikeValue(searchBoxInPortal, targetValue);
          searchBoxInPortal.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", keyCode: 40, bubbles: true }));
        }

        const opts = Array.from(
          (listbox || document).querySelectorAll('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root, li[role="option"]')
        );

        // Check if dropdown is currently in "Loading..." debounce state
        const isLoading = opts.some((o) => /loading|searching|завантаження/i.test(o.textContent || "")) ||
          !!document.querySelector('.MuiAutocomplete-loading, [class*="loading"], [role="progressbar"]');

        if (opts.length > 0 && !isLoading) {
          return { listbox, options: opts };
        }

        await new Promise((r) => setTimeout(r, 120));
      }

      const listboxId = activeInput.getAttribute("aria-controls") || activeInput.getAttribute("aria-owns") || inputEl.getAttribute("aria-controls");
      const listbox = listboxId ? document.getElementById(listboxId) : document.querySelector('[role="listbox"], .MuiAutocomplete-listbox, .MuiMenu-list');
      const opts = Array.from(
        (listbox || document).querySelectorAll('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root, li[role="option"]')
      );
      return { listbox, options: opts };
    }

    // 3. Wait for options with async debounce support (Toggl, Ashby, etc.)
    const { listbox, options } = await waitForOptions(1500);

    const findMatch = (opts) => {
      if (!isDialCode) return opts[pickOption(opts.map((o) => o.textContent || ""), targetValue)];
      return opts.find((opt) => {
        const txt = (opt.textContent || "").toLowerCase().trim();
        const digits = txt.replace(/\D/g, "");
        const targetDigits = targetNorm.replace(/\D/g, "");
        return digits === targetDigits || digits.endsWith(targetDigits) || txt.includes(targetNorm);
      });
    };

    if (options.length > 0) {
      let match = findMatch(options);

      // ITEM B FIX: Cap scrolling iterations to avoid long loops on huge lists (e.g. 3000+ cities)
      if (!match && listbox && listbox.scrollHeight > listbox.clientHeight) {
        const stepSize = Math.max(listbox.clientHeight, 300);
        const maxSteps = Math.min(10, Math.ceil(listbox.scrollHeight / stepSize) + 1);
        const scrollStartTime = Date.now();
        const scrollTimeoutMs = 1000;
        for (let scrollStep = 0; scrollStep < maxSteps && !match; scrollStep++) {
          if (Date.now() - scrollStartTime > scrollTimeoutMs) break;
          listbox.scrollTop += stepSize;
          listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 40));

          const curOptions = Array.from(
            listbox.querySelectorAll('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root, li[role="option"]')
          );
          match = findMatch(curOptions);
        }
      }

      if (match) {
        match.scrollIntoView?.({ block: "center", behavior: "instant" });
        await new Promise((r) => setTimeout(r, 30));
        dispatchUserClick(match);

        activeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
        activeInput.dispatchEvent(new Event("change", { bubbles: true }));
        activeInput.blur();
        if (wasReadOnly) {
          try { inputEl.readOnly = true; } catch (e) {}
        }
        return true;
      }
    }

    if (wasReadOnly) {
      try { inputEl.readOnly = true; } catch (e) {}
    }

    // Fallback: press Enter to select active option
    activeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    activeInput.blur();
    return false;
  }

  // Helper: Set native checked for radio/checkbox
  function setNativeChecked(element, checked) {
    if (!element) return;
    element.focus();
    // click() toggles a checkbox, so only click when the state actually needs to change
    // (setting .checked first and then clicking used to flip checkboxes straight back off).
    if (element.checked !== checked) element.click();
    if (element.checked !== checked) {
      element.checked = checked;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    element.setAttribute("data-autofill-highlight", "1");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isComboboxEl(el) {
    return (
      el.getAttribute("role") === "combobox" ||
      el.classList.contains("MuiAutocomplete-input") ||
      el.classList.contains("MuiSelect-select") ||
      el.classList.contains("select__input") ||
      el.getAttribute("aria-autocomplete") === "list" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.hasAttribute("aria-controls")
    );
  }

  const YES_RE = /^(yes|true|так|tak|ja|oui|sí|si|sì|sim)(?!\p{L})/iu;
  const NO_RE = /^(no|false|ні|nie|nein|non|não|nee)(?!\p{L})/iu;
  const DECLINE_RE = new RegExp(
    [
      "decline|prefer not|choose not|not to (say|disclose|answer|self)|don ?t wish|do not wish|rather not",
      "не бажаю|не хочу (вказувати|відповідати)|волію не",
      "wolę nie|nie chcę (podawać|odpowiadać)|odmawiam",
      "keine angabe|möchte (ich )?(das )?nicht|nicht angeben",
      "ne souhaite pas|préfère ne pas|je refuse",
      "prefiero no|no deseo|no quiero",
      "preferisco non|non desidero|non voglio",
      "prefiro não|não desejo|não quero",
      "zeg ik liever niet|wil ik liever niet|wil ik niet|geen antwoord"
    ].join("|"),
    "iu"
  );

  // Index of the option best matching `value` (exact > prefix > substring), or -1.
  // Yes/No/Decline are matched semantically so "Yes" picks "Yes, I am authorized to work".
  function pickOption(texts, value) {
    const v = normalizeQuestion(value);
    if (!v) return -1;
    const t = texts.map(normalizeQuestion);
    const tests = YES_RE.test(v) && v.split(" ").length === 1
      ? [(x) => YES_RE.test(x)]
      : NO_RE.test(v) && v.split(" ").length === 1
        ? [(x) => NO_RE.test(x)]
        : v === "decline"
          ? [(x) => DECLINE_RE.test(x)]
          : [(x) => x === v, (x) => x.startsWith(v), (x) => x.includes(v), (x) => x.length > 2 && v.includes(x)];
    for (const test of tests) {
      const i = t.findIndex((x) => x && test(x));
      if (i >= 0) return i;
    }
    return -1;
  }

  // Resume source: file uploaded in the popup (chrome.storage) first, then the optional
  // bridge (per-role PDF from RESUME_REPO_PATH), fetched via the background worker to bypass page CSP.
  async function getResumeFile(profileKey) {
    let src = (await chrome.storage.local.get("resumeFile")).resumeFile;
    if (!src?.base64) {
      src = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: "FETCH_RESUME_BLOB", profileKey }, (resp) => resolve(resp))
      );
    }
    if (!src?.base64) return null;
    const bytes = Uint8Array.from(atob(src.base64), (c) => c.charCodeAt(0));
    const type = src.mimeType || "application/pdf";
    return new File([bytes], src.fileName || "resume.pdf", { type, lastModified: Date.now() });
  }

  // Helper: Attach resume file via DataTransfer
  async function attachResumeFile(inputEl, profileKey) {
    try {
      const file = await getResumeFile(profileKey);
      if (!file) {
        console.warn("[Job Form Filler] No resume file: upload one in the popup Profile tab.");
        return false;
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      // Assign to input
      inputEl.files = dataTransfer.files;

      // Dispatch standard input & change events
      inputEl.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

      // Find dropzone containers (MUI, Ashby, Greenhouse, Deel UI drop targets)
      const dropzone =
        inputEl.closest('[class*="dropzone"], [class*="upload"], [class*="file-upload"], .MuiListItem-root, .MuiBox-root, .MuiPaper-root, label') ||
        document.querySelector('.MuiListItem-root-DeelUICellMain-listItem, [class*="DeelUI"]') ||
        inputEl.parentElement;

      if (dropzone) {
        try {
          dropzone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
          dropzone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
          dropzone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
        } catch (e) {}
      }

      // Also dispatch drop on document.body for full-page drop listeners
      try {
        const globalDropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
        document.dispatchEvent(globalDropEvent);
      } catch (e) {}

      inputEl.setAttribute("data-autofill-highlight", "1");
      console.log("[Job Form Filler] Successfully attached resume PDF:", file.name, `(${file.size} bytes)`);
      return true;
    } catch (err) {
      console.warn("[Job Form Filler] File upload injection error:", err.message);
      return false;
    }
  }

  // Helper: Detect ATS Platform
  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    const html = document.documentElement.innerHTML.slice(0, 10000).toLowerCase();

    if (host.includes("ashbyhq.com") || document.querySelector('[data-testid*="ashby"]') || html.includes("ashby")) {
      return "Ashby";
    }
    if (host.includes("greenhouse.io") || document.querySelector("#application_form") || html.includes("greenhouse")) {
      return "Greenhouse";
    }
    if (host.includes("lever.co") || document.querySelector(".application-form") || html.includes("lever")) {
      return "Lever";
    }
    if (host.includes("workable.com") || document.querySelector('[data-ui="application-form"]')) {
      return "Workable";
    }
    if (host.includes("linkedin.com") && document.querySelector(".jobs-easy-apply-modal")) {
      return "LinkedIn Easy Apply";
    }
    if (host === "djinni.co" || host.endsWith(".djinni.co")) {
      return "Djinni";
    }
    return "Generic Job Board";
  }

  // ── Djinni helpers ────────────────────────────────────────────────────────

  /**
   * Returns true when the current URL is a Djinni vacancy page (/jobs/<id>-<slug>/).
   * Returns false on the jobs list/filter page (/jobs/ with query params).
   */
  function isDjinniVacancyPage() {
    const host = window.location.hostname.toLowerCase();
    if (host !== "djinni.co" && !host.endsWith(".djinni.co")) return false;
    return /^\/jobs\/\d+-[^/]+\/?$/.test(window.location.pathname);
  }

  /**
   * Returns true when the current URL is a Djinni jobs listing page
   * (/jobs/ with no vacancy id-slug, i.e. the search/filter page).
   */
  function isDjinniListPage() {
    const host = window.location.hostname.toLowerCase();
    if (host !== "djinni.co" && !host.endsWith(".djinni.co")) return false;
    return /^\/jobs\/?$/.test(window.location.pathname);
  }

  /**
   * Read the Djinni inline apply form state.
   *
   * The form is hidden until the candidate clicks "Відгукнутися на вакансію".
   * Once open, it contains:
   *   - message textarea (fieldId: "djinni_message")
   *   - resume combobox (fieldId: "djinni_resume")
   *   - salary number input (fieldId: "djinni_salary"), only visible after
   *     clicking "Змінити для цієї вакансії"
   *
   * Also reads the logged-in sidebar facts that are not available server-side:
   *   - salary fit hint ("Ваші зарплатні очікування …")
   *   - "Ваші очікування" (the candidate's current salary setting)
   *   - already-applied state ("Ви вже відгукнулись…")
   */
  function hasHiddenAncestor(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.classList.contains("d-none") || window.getComputedStyle(n).display === "none") return true;
    }
    return false;
  }

  // Real Djinni selectors (captured from a logged-in page, see test/fixtures/djinni-apply-form-logged-in.html).
  const DJ = {
    message: "#apply_form textarea[name='message']",
    resume: "#apply_form select[name='cv_file_upload_id']",
    salaryInput: "#apply_form input[name='salary_changed']",
    salaryToggle: "#apply_form .js-salary-toggle-btn",
    quiz: "#apply_form [name^='answer_']"
  };

  const djText = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");

  // Recruiter screening questions ("Запитання від рекрутера"): one entry per answer_<id> control (radio groups merged).
  // They are knockout questions, so every one is flagged humanRequired: the caller must ask the candidate.
  function getDjinniQuizQuestions() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(DJ.quiz)) {
      if (seen.has(el.name)) continue;
      seen.add(el.name);
      const group = Array.from(document.querySelectorAll(DJ.quiz)).filter((x) => x.name === el.name);
      const labelOf = (x) => djText(x.id && document.querySelector(`label[for="${CSS.escape(x.id)}"]`));
      const isChoice = el.type === "radio" || el.type === "checkbox";
      const q = {
        fieldId: el.name,
        label: isChoice ? djText(el.closest(".mb-3, fieldset")?.querySelector("legend, .form-label, label")) : labelOf(el),
        type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.type === "radio" ? "radio" : el.type === "checkbox" ? "checkbox-group" : el.type || "text",
        required: group.some((x) => x.required),
        value: isChoice ? group.filter((x) => x.checked).map(labelOf).join(", ") : el.value,
        humanRequired: true,
        knockout: true
      };
      if (el.tagName === "SELECT") q.options = Array.from(el.options).map((o) => o.text.trim()).filter(Boolean);
      if (isChoice) q.options = group.map(labelOf);
      out.push(q);
    }
    return out;
  }

  function getDjinniFormState() {
    // ── Already-applied detection ─────────────────────────────────────────
    const bodyText = document.body ? document.body.innerText : "";
    const alreadyApplied = /ви вже відгукнулись на цю вакансію/i.test(bodyText);

    // ── Sidebar logged-in facts ──────────────────────────────────────────
    let salaryFitHint = null;
    const aside = document.querySelector("aside");
    const asideText = aside ? aside.innerText || aside.textContent || "" : "";
    const fitMatch = asideText.match(/(ваші зарплатні очікування[^\n.]+)/i);
    if (fitMatch) salaryFitHint = fitMatch[1].trim();
    const expectMatch = asideText.match(/ваші очікування:\s*(\S+)/i);
    if (expectMatch && !salaryFitHint) salaryFitHint = `Ваші очікування: ${expectMatch[1].trim()}`;

    // The form is always in the DOM (#apply_form, style="display:none") until an opener is clicked.
    const messageTextarea = document.querySelector(DJ.message);
    if (!messageTextarea || hasHiddenAncestor(messageTextarea)) {
      return { formClosed: true, openerLabel: "Відгукнутися на вакансію", alreadyApplied, salaryFitHint };
    }

    const fields = [
      {
        fieldId: "djinni_message",
        label: "Повідомлення",
        type: "textarea",
        required: true,
        minLength: 50,
        placeholder: messageTextarea.placeholder || "",
        value: messageTextarea.value || ""
      }
    ];

    // Resume: native select behind TomSelect. Duplicate option texts are collapsed.
    const resumeSelect = document.querySelector(DJ.resume);
    if (resumeSelect) {
      const options = Array.from(new Set(Array.from(resumeSelect.options).map((o) => o.text.trim()).filter(Boolean)));
      fields.push({
        fieldId: "djinni_resume",
        label: "Резюме",
        type: "select",
        options,
        value: resumeSelect.options[resumeSelect.selectedIndex]?.text.trim() || ""
      });
    }

    // Salary override: input.d-none until .js-salary-toggle-btn is clicked.
    const salaryInput = document.querySelector(DJ.salaryInput);
    const overrideOpen = !!salaryInput && !hasHiddenAncestor(salaryInput);
    fields.push({
      fieldId: "djinni_salary",
      label: "Зарплатні очікування",
      type: "number",
      overrideOpen,
      openerLabel: overrideOpen ? null : "Змінити для цієї вакансії",
      currentDisplay: djText(document.querySelector("#apply_form .js-salary-text-value")) || null,
      value: overrideOpen ? salaryInput.value : null
    });

    return {
      formClosed: false,
      fields,
      questions: getDjinniQuizQuestions(),
      alreadyApplied,
      salaryFitHint,
      // Final submit button "Надіслати відгук" is never clicked by tools
      submitDenied: true,
      submitLabel: "Надіслати відгук"
    };
  }

  /**
   * Fill the Djinni inline apply form: message, resume (TomSelect-aware), salary override and
   * recruiter quiz answers (keyed by answer_<id> or by label text).
   * @returns {{filled: string[], notFound: string[], failed: string[]}}
   */
  function fillDjinniForm(answers) {
    const filled = [];
    const notFound = [];
    const failed = [];

    for (const [key, value] of Object.entries(answers || {})) {
      if (value === undefined || value === null) continue;
      const keyNorm = key.toLowerCase().replace(/\s+/g, "_");

      if (keyNorm === "djinni_message") {
        const ta = document.querySelector(DJ.message);
        if (!ta) { notFound.push(key); continue; }
        try {
          replaceFieldValue(ta, String(value));
          filled.push(key);
        } catch (e) { failed.push(key); }
        continue;
      }

      if (keyNorm === "djinni_resume") {
        const sel = document.querySelector(DJ.resume);
        if (!sel) { notFound.push(key); continue; }
        const target = String(value).trim().toLowerCase();
        const opt = Array.from(sel.options).find((o) => o.text.trim().toLowerCase() === target);
        if (!opt) { failed.push(`${key} (option "${value}" not found)`); continue; }
        if (sel.tomselect) {
          sel.tomselect.setValue(opt.value);
        } else {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        filled.push(key);
        continue;
      }

      if (keyNorm === "djinni_salary") {
        let inp = document.querySelector(DJ.salaryInput);
        if (!inp) { notFound.push(key); continue; }
        if (hasHiddenAncestor(inp)) {
          // Reveal the per-vacancy override first (a plain navigation toggle, not a submit).
          const toggle = document.querySelector(DJ.salaryToggle);
          if (toggle) dispatchUserClick(toggle);
          if (hasHiddenAncestor(inp)) { failed.push(`${key} (override input still hidden; click "Змінити для цієї вакансії")`); continue; }
        }
        try {
          replaceFieldValue(inp, String(value));
          filled.push(key);
        } catch (e) { failed.push(key); }
        continue;
      }

      // Recruiter quiz answer, by name (answer_<id>) or exact label text
      const quiz = getDjinniQuizQuestions().find((q) => q.fieldId === key || q.label.toLowerCase() === String(key).trim().toLowerCase());
      if (quiz) {
        const els = Array.from(document.querySelectorAll(DJ.quiz)).filter((x) => x.name === quiz.fieldId);
        try {
          if (els[0].type === "radio" || els[0].type === "checkbox") {
            const want = String(value).trim().toLowerCase();
            const idx = quiz.options.findIndex((o) => o.toLowerCase() === want);
            if (idx < 0) { failed.push(`${key} (option "${value}" not found)`); continue; }
            dispatchUserClick(els[idx]);
          } else if (els[0].tagName === "SELECT") {
            const opt = Array.from(els[0].options).find((o) => o.text.trim().toLowerCase() === String(value).trim().toLowerCase());
            if (!opt) { failed.push(`${key} (option "${value}" not found)`); continue; }
            els[0].value = opt.value;
            els[0].dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            replaceFieldValue(els[0], String(value));
          }
          filled.push(key);
        } catch (e) { failed.push(key); }
        continue;
      }

      notFound.push(key);
    }

    return { filled, notFound, failed };
  }

  // Helper to check if text is a generic non-question placeholder
  function isGenericPlaceholder(text) {
    if (!text) return true;
    const lower = text.trim().toLowerCase();
    return (
      lower === "select one" ||
      lower === "select one or more" ||
      lower === "select" ||
      lower === "choose" ||
      lower === "choose one" ||
      lower === "type to search" ||
      lower === "option" ||
      YES_RE.test(lower) && lower.split(/\s+/).length === 1 ||
      NO_RE.test(lower) && lower.split(/\s+/).length === 1 ||
      /^(оберіть|виберіть|wybierz|auswählen|bitte wählen|sélectionner|choisir|seleccionar|selecciona|seleziona|selecione|selecionar|selecteer|kies)\b.{0,15}$/iu.test(lower)
    );
  }

  // Helper: Extract visible label for an input element
  function getElementLabel(el) {
    const isOptionInput = el.type === "radio" || el.type === "checkbox";

    // 1. If it's a radio or checkbox, find the GROUP question title!
    if (isOptionInput) {
      const group = el.closest(
        '.MuiFormControl-root, .MuiFormGroup-root, fieldset, [role="radiogroup"], [role="group"], [class*="RadioGroup"], [class*="question"], [data-testid*="question"]'
      );
      if (group) {
        const groupLabel = group.querySelector(
          'legend, .MuiFormLabel-root, [class*="FormLabel"], [class*="questionTitle"], [class*="title"], h3, h4, p[class*="heading"]'
        );
        if (groupLabel && groupLabel !== el && !groupLabel.contains(el)) {
          const txt = groupLabel.innerText.trim();
          if (txt && !isGenericPlaceholder(txt)) return txt;
        }

        let prev = group.previousElementSibling;
        while (prev) {
          if (prev.matches("label, h3, h4, p, span, div")) {
            const txt = prev.innerText.trim();
            if (txt && !isGenericPlaceholder(txt) && txt.length < 150) return txt;
          }
          prev = prev.previousElementSibling;
        }
      }
    }

    // 2. Check aria-label or aria-labelledby
    if (el.getAttribute("aria-label")) {
      const aria = el.getAttribute("aria-label").trim();
      if (!isGenericPlaceholder(aria)) return aria;
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        const txt = labelEl.innerText.trim();
        if (txt && !isGenericPlaceholder(txt)) return txt;
      }
    }

    // 3. Check <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) {
        const txt = label.innerText.trim();
        if (txt && !isGenericPlaceholder(txt)) return txt;
      }
    }

    // 4. Check enclosing question container (Ashby, MUI, Greenhouse, Lever, Deel).
    // Stop climbing once the container spans several fields (a row/section/form): any label found
    // there most likely belongs to a sibling field (e.g. "First name" labelling "Last name").
    let curr = el.parentElement;
    for (let depth = 0; depth < 5 && curr; depth++) {
      if (curr.querySelectorAll("input:not([type='hidden']), textarea, select").length > 2) break;
      const labelCandidate = curr.querySelector(
        '.MuiFormLabel-root, label:not(.MuiFormControlLabel-root), .label, [class*="label"]:not([class*="FormControlLabel"]), [class*="title"], [data-testid*="label"], [data-testid*="title"], h3, h4, strong, span[class*="heading"]'
      );
      if (labelCandidate && labelCandidate !== el && !labelCandidate.contains(el)) {
        const txt = labelCandidate.innerText.trim();
        if (txt && !isGenericPlaceholder(txt) && txt.length < 200) {
          return txt;
        }
      }
      curr = curr.parentElement;
    }

    // 5. Preceding sibling
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.matches("label, span, p, div, h4, h5")) {
        const txt = prev.innerText.trim();
        if (txt && !isGenericPlaceholder(txt) && txt.length < 150) return txt;
      }
      prev = prev.previousElementSibling;
    }

    // 6. Check enclosing <label> (radios use it as their option text, not the question)
    if (el.type !== "radio") {
      const parentLabel = el.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        const inputs = clone.querySelectorAll("input, textarea, select");
        inputs.forEach((i) => i.remove());
        const txt = clone.innerText.trim();
        if (txt && !isGenericPlaceholder(txt)) return txt;
      }
    }

    // 7. Attributes fallback
    const placeholder = el.getAttribute("placeholder") || "";
    if (placeholder && !isGenericPlaceholder(placeholder)) return placeholder;

    return el.getAttribute("name") || el.getAttribute("id") || el.getAttribute("data-testid") || "";
  }

  // Helper to extract option text for radio / checkbox
  function getOptionLabel(el) {
    // Option names are real words ("Yes", "No", "Led a remote team"), never the browser default "on".
    const usable = (t) => {
      const s = String(t || "").replace(/\s+/g, " ").trim();
      return s && !/^(on|\*)$/i.test(s) ? s : "";
    };
    const parentLabel = el.closest("label, .MuiFormControlLabel-root");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      const inputs = clone.querySelectorAll("input, textarea, select");
      inputs.forEach((i) => i.remove());
      const txt = usable(clone.innerText || clone.textContent);
      if (txt) return txt;
    }
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const txt = usable(forLabel && (forLabel.innerText || forLabel.textContent));
      if (txt) return txt;
    }
    const aria = usable(el.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const txt = usable(
        labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
      );
      if (txt) return txt;
    }
    // Text right after the control (e.g. <input><span>Option</span>), without swallowing sibling options.
    const next = el.nextElementSibling;
    if (next && !next.matches("input, textarea, select") && !next.querySelector("input, textarea, select")) {
      const txt = usable(next.textContent);
      if (txt) return txt;
    }
    const nextText = el.nextSibling && el.nextSibling.nodeType === 3 ? usable(el.nextSibling.textContent) : "";
    if (nextText) return nextText;
    return usable(el.value) || usable(el.innerText) || "";
  }

  // Generate unique selector/path for an element
  function getElementSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) {
      const nameSelector = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (document.querySelectorAll(nameSelector).length === 1) return nameSelector;
    }
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

    const path = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.className && typeof current.className === "string") {
        const classes = current.className
          .split(/\s+/)
          .filter((c) => c && !c.startsWith("jff-") && !c.includes(":"))
          .slice(0, 2);
        if (classes.length) selector += "." + classes.join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) {
          selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      path.unshift(selector);
      current = parent;
    }
    return path.join(" > ");
  }

  // Auto-switch to Application tab if page has Overview/Application tabs
  function tryAutoSwitchToApplicationTab() {
    const tabs = Array.from(document.querySelectorAll("button, [role='tab'], a, div, span"));
    const appTab = tabs.find((el) => {
      const txt = (el.innerText || "").trim().toLowerCase();
      return (
        txt === "application" ||
        txt === "apply" ||
        txt === "apply for this job" ||
        txt === "apply now" ||
        txt === "подати заявку"
      );
    });
    if (appTab && appTab.getAttribute("aria-selected") !== "true" && !appTab.classList.contains("active")) {
      appTab.click();
      return true;
    }
    return false;
  }

  // Scan all form fields on page
  function scanFormFields() {
    let rawElements = Array.from(
      document.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], .MuiSelect-select, button[aria-haspopup='listbox']")
    );
    // Only the real application form: drop header/footer/nav/cookie/login/country-search noise, then
    // keep what is inside the detected form (unless that would leave almost nothing).
    rawElements = rawElements.filter((el) => !H.fhIsNoise(el));
    const applicationScope = H.fhGetApplicationScope(document);
    if (applicationScope) {
      const scoped = rawElements.filter((el) => applicationScope.contains(el));
      if (scoped.length >= 2) rawElements = scoped;
    }

    const fields = [];
    const radioGroupsProcessed = new Set();
    const checkboxGroups = new Map();
    const seenElements = new Set();

    rawElements.forEach((el, index) => {
      if (seenElements.has(el)) return;
      seenElements.add(el);

      const isCombobox =
        el.getAttribute("role") === "combobox" ||
        el.classList.contains("MuiAutocomplete-input") ||
        el.classList.contains("select__input") ||
        el.classList.contains("MuiSelect-select") ||
        el.getAttribute("aria-haspopup") === "listbox" ||
        el.hasAttribute("aria-controls");

      const type = (el.getAttribute("type") || (isCombobox ? "combobox" : el.tagName.toLowerCase())).toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type) && !isCombobox) return;
      if (type === "hidden" && !isCombobox) return;

      const style = window.getComputedStyle(el);
      // ATS platforms (Ashby, Greenhouse, Lever) frequently hide raw <input type="file"> behind drag-and-drop buttons
      if (style.display === "none" && type !== "file" && !isCombobox) return;
      if (style.visibility === "hidden" && type !== "file" && !isCombobox) return;

      // Checkboxes that belong together (same name, or one fieldset / role=group) are ONE multi-select field,
      // not N identically-labelled checkboxes.
      if (type === "checkbox") {
        const container = el.closest("fieldset, [role='group'], .MuiFormGroup-root");
        const sameName = el.name ? Array.from(document.getElementsByName(el.name)).filter((x) => x.type === "checkbox") : [];
        const inContainer = container ? container.querySelectorAll("input[type='checkbox']").length : 0;
        const cbKey = inContainer >= 2 ? container : sameName.length >= 2 ? `name:${el.name}` : null;
        if (cbKey) {
          const option = {
            element: el,
            selector: getElementSelector(el),
            label: getOptionLabel(el),
            value: el.value,
            checked: el.checked
          };
          const existing = checkboxGroups.get(cbKey);
          if (existing) {
            existing.options.push(option);
            return;
          }
          const groupQuestionLabel = getElementLabel(el);
          const fullIdentifier = `${groupQuestionLabel} | ${el.name || ""} | checkbox-group`.toLowerCase();
          const group = {
            element: el,
            fieldId: `checkbox_group_${el.name || index}`,
            selector: getElementSelector(el),
            tagName: "input",
            type: "checkbox-group",
            label: groupQuestionLabel,
            name: el.name,
            id: el.id,
            required: el.required,
            value: "",
            options: [option],
            fullIdentifier,
            classification: classifyField(fullIdentifier, "checkbox-group", el)
          };
          checkboxGroups.set(cbKey, group);
          fields.push(group);
          return;
        }
      }

      // Group radio buttons by name or parent radiogroup
      if (type === "radio") {
        const groupKey = el.name || el.closest(".MuiRadioGroup-root, [role='radiogroup']")?.id || `radiogroup_${index}`;
        const optionItem = {
          element: el,
          selector: getElementSelector(el),
          label: getOptionLabel(el),
          value: el.value,
          checked: el.checked
        };

        const existingGroup = fields.find((f) => f.type === "radio-group" && f.groupKey === groupKey);
        if (existingGroup) {
          existingGroup.options.push(optionItem);
          return;
        } else {
          const groupQuestionLabel = getElementLabel(el);
          const fullIdentifier = `${groupQuestionLabel} | ${el.name || ""} | radio`.toLowerCase();

          fields.push({
            element: el,
            fieldId: `radio_group_${el.name || index}`,
            groupKey: groupKey,
            selector: getElementSelector(el),
            tagName: "input",
            type: "radio-group",
            label: groupQuestionLabel,
            name: el.name,
            id: el.id,
            required: el.required,
            value: el.checked ? optionItem.label : "",
            options: [optionItem],
            fullIdentifier: fullIdentifier,
            classification: classifyField(fullIdentifier, "radio-group", el)
          });
          return;
        }
      }

      // Blank / "*" / "Required" labels fall back to aria-label, placeholder, then the field name.
      const rawLabel = getElementLabel(el);
      const label =
        H.fhPickLabel([rawLabel, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name")]) ||
        rawLabel ||
        "";
      const name = (el.getAttribute("name") || "").toLowerCase();
      const id = (el.getAttribute("id") || "").toLowerCase();
      const testid = (el.getAttribute("data-testid") || "").toLowerCase();
      const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
      const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
      const fullIdentifier = `${label} | ${name} | ${id} | ${testid} | ${placeholder} | ${autocomplete}`.toLowerCase();

      // Collect options for select
      let options = [];
      if (el.tagName.toLowerCase() === "select") {
        options = Array.from(el.options).map((opt) => ({
          value: opt.value,
          text: opt.text.trim()
        }));
      }

      const fieldData = {
        element: el,
        fieldId: `field_${index}${id || name ? "_" + (id || name).slice(0, 40) : ""}`,
        selector: getElementSelector(el),
        tagName: el.tagName.toLowerCase(),
        type: type,
        label: label,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder || "",
        required: el.required || el.getAttribute("aria-required") === "true",
        value: el.value || el.innerText || "",
        options: options,
        fullIdentifier: fullIdentifier,
        classification: classifyField(fullIdentifier, type, el)
      };
      if (fieldData.classification?.type === "consent") {
        fieldData.type = "consent";
      }
      fields.push(fieldData);
    });

    // Scan for Ashby Yes/No toggle button pairs tied to hidden/underlying checkboxes
    const toggleContainers = document.querySelectorAll(
      '[data-testid*="question"], .ashby-application-form-question, [class*="FieldContainer"], fieldset'
    );
    toggleContainers.forEach((container, cIdx) => {
      const yesBtn = container.querySelector('button[data-option="yes"], button[value="yes"], button[aria-label*="Yes" i]');
      const noBtn = container.querySelector('button[data-option="no"], button[value="no"], button[aria-label*="No" i]');
      if (yesBtn && noBtn) {
        const underlyingInput = container.querySelector('input[type="checkbox"], input[type="radio"], input[type="hidden"]');
        const questionLabel = getElementLabel(yesBtn) || container.querySelector("label, h3, h4, strong")?.innerText?.trim() || "";
        const fullIdentifier = `${questionLabel} | toggle | yesno`.toLowerCase();

        const toggleField = {
          element: container,
          fieldId: `toggle_pair_${cIdx}`,
          selector: getElementSelector(container),
          tagName: "div",
          type: "toggle-checkbox-pair",
          label: questionLabel,
          required: container.querySelector('[aria-required="true"], .required') !== null,
          underlyingInput: underlyingInput,
          yesButton: yesBtn,
          noButton: noBtn,
          value: underlyingInput ? (underlyingInput.checked ? "Yes" : "No") : "",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" }
          ],
          fullIdentifier: fullIdentifier,
          classification: classifyField(fullIdentifier, "toggle-checkbox-pair", container)
        };
        if (toggleField.classification?.type === "consent") {
          toggleField.type = "consent";
        }
        fields.push(toggleField);
      }
    });

    return fields;
  }

  // HTML autocomplete tokens are the most reliable signal a form gives; checked before labels.
  const AUTOCOMPLETE_KEYS = {
    "given-name": "firstName",
    "family-name": "lastName",
    name: "fullName",
    nickname: "preferredName",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    "tel-country-code": "phoneDialCode",
    "street-address": "address",
    "address-line1": "address",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "postalCode",
    country: "country",
    "country-name": "country",
    organization: "currentCompany",
    "organization-title": "currentTitle"
  };

  // \b is ASCII-only in JS regexes, so it never matches next to Cyrillic or accented letters.
  // rx() joins alternatives and swaps every \b for a Unicode-aware word boundary.
  const WORD_BOUNDARY = "(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))";
  const rx = (...alts) => new RegExp(alts.join("|").replace(/\\b/g, WORD_BOUNDARY), "iu");

  // Ordered [key, match, exclude] rules over `${fullIdentifier} | type:${type}`. First hit wins,
  // so specific rules (full name, dial code, relocation, work authorization) sit above broad ones
  // (first name, phone, location, country). One alternative per language, in FORM_LANGUAGES order:
  // en, uk, pl, de, fr, es, it, pt, nl.
  const FIELD_RULES = [
    ["preferredName", rx(
      String.raw`preferred[\s_-]?(first[\s_-]?)?name|nickname`, String.raw`бажане ім'я`, String.raw`preferowane imię`,
      String.raw`rufname|bevorzugter name`, String.raw`nom d'usage|prénom d'usage`, String.raw`nombre preferido`,
      String.raw`nome preferito`, String.raw`nome preferido`, String.raw`roepnaam|voorkeursnaam`)],
    ["fullName", rx(
      String.raw`full[\s_-]?name|candidate[\s_-]?name|your name|^name\b`,
      String.raw`\bпіб\b|повне ім'я|ім'я (та|і) прізвище|прізвище,? ім'я|ваше ім'я`,
      String.raw`imię i nazwisko`, String.raw`vollständiger name|vor- und nachname`, String.raw`nom complet|prénom et nom`,
      String.raw`nombre completo|nombre y apellido`, String.raw`nome completo|nome e cognome`, String.raw`nome completo`,
      String.raw`volledige naam|voor- en achternaam`),
      rx(String.raw`company|school|employer|reference|university|компан|firma|unternehmen|entreprise|empresa|azienda|bedrijf`)],
    ["firstName", rx(
      String.raw`first[\s_-]?name|\bfname\b|given[\s_-]?name|forename`, String.raw`\bім'я\b`, String.raw`\bimię\b`,
      String.raw`vorname`, String.raw`prénom`, String.raw`^nombre\b|primer nombre`, String.raw`^nome\b`,
      String.raw`primeiro nome`, String.raw`voornaam`),
      rx(String.raw`last|surname|прізвище|nazwisko|nachname|nom de famille|apellido|cognome|sobrenome|apelido|achternaam|azienda|empresa`)],
    ["lastName", rx(
      String.raw`last[\s_-]?name|\blname\b|surname|family[\s_-]?name`, String.raw`прізвище`, String.raw`nazwisko`,
      String.raw`nachname|familienname`, String.raw`nom de famille|^nom\b`, String.raw`apellido`, String.raw`cognome`,
      String.raw`sobrenome|apelido`, String.raw`achternaam`),
      rx(String.raw`entreprise|société|complet|utilisateur`)],
    ["pronouns", rx(String.raw`pronoun`, String.raw`займенник`, String.raw`zaimek|zaimki`, String.raw`pronomen`, String.raw`\bpronom`, String.raw`voornaamwoord`)],
    ["email", rx(
      String.raw`e-?mail|type:email`, String.raw`\bпошт[аиі]\b|ел\.? ?пошт|електронн(а|ої) пошт`, String.raw`\bpoczta\b`,
      String.raw`courriel`, String.raw`correo`, String.raw`posta elettronica`, String.raw`correio eletr[óô]nico`)],
    ["phoneDialCode", rx(
      String.raw`dial[\s_-]?code|country[\s_-]?code|calling[\s_-]?code|phone[\s_-]?code|phone_?country`,
      String.raw`код країни|телефонний код`, String.raw`kod kraju|numer kierunkowy`, String.raw`ländervorwahl|landesvorwahl`,
      String.raw`indicatif`, String.raw`código de país|prefijo`, String.raw`prefisso`, String.raw`código do país|indicativo`,
      String.raw`landcode|landnummer`)],
    ["phone", rx(
      String.raw`phone|mobile|telephone|contact number|type:tel`, String.raw`телефон|мобільн`, String.raw`telefon|komórk`,
      String.raw`handy|mobilnummer`, String.raw`téléphone|portable`, String.raw`teléfono|celular|móvil`,
      String.raw`telefono|cellulare`, String.raw`telefone|telemóvel`, String.raw`telefoon|mobiel`)],
    ["linkedin", rx(String.raw`linked-?in`)],
    ["github", rx(String.raw`git-?hub`)],
    ["twitter", rx(String.raw`twitter|\bx\.com\b|\bx \(twitter\)`)],
    ["website", rx(
      String.raw`website|portfolio|personal (site|url)|blog|homepage`, String.raw`\bсайт|портфоліо`,
      String.raw`strona (www|internetowa)`, String.raw`webseite`, String.raw`site (web|internet|personnel)`,
      String.raw`sitio web|página web|portafolio`, String.raw`sito web|sito personale`, String.raw`site pessoal|página pessoal`,
      String.raw`persoonlijke website`)],
    ["workAuthorization", rx(
      String.raw`authori[sz]ed to work|legal(ly)? (right|authori[sz]ed)|right to work|eligible to work|work permit|work authori[sz]ation`,
      String.raw`дозв[іо]л на роботу|право на роботу`, String.raw`pozwoleni[ea] na pracę|prawo do pracy`,
      String.raw`arbeitserlaubnis|arbeitsgenehmigung`, String.raw`autorisation de travail|permis de travail`,
      String.raw`permiso de trabajo|autorización para trabajar`, String.raw`permesso di lavoro|autorizzat[oa] a lavorare`,
      String.raw`autorização de trabalho|autorizad[oa] a trabalhar`, String.raw`werkvergunning|bevoegd om te werken`)],
    ["sponsorship", rx(
      String.raw`sponsor|\bvisa\b`, String.raw`\bвіз[аиу]\b|спонсор`, String.raw`\bwiz[ayę]\b`, String.raw`visum`,
      String.raw`parrainage`, String.raw`patrocinio`, String.raw`\bvisto\b|sponsorizzazione`, String.raw`patrocínio`)],
    ["relocation", rx(
      String.raw`relocat`, String.raw`релокац|переїзд`, String.raw`relokac|przeprowadz`, String.raw`umzug|umzieh|relokation`,
      String.raw`déménag|relocalis|mobilité géographique`, String.raw`reubica|traslad`, String.raw`trasferir|trasferimento`,
      String.raw`realoca|mudar-se|mudar de cidade`, String.raw`verhuiz`)],
    ["address", rx(
      String.raw`street|address[\s_-]?line[\s_-]?1|address[\s_-]?1\b|^address\b`, String.raw`\bадрес[аи]\b|вулиця`,
      String.raw`^adres\b|\bulica\b`, String.raw`straße|strasse|^adresse\b|anschrift`, String.raw`\brue\b`,
      String.raw`^dirección\b|\bcalle\b`, String.raw`^indirizzo\b|indirizzo di residenza`, String.raw`^morada\b|^endereço\b|\brua\b`,
      String.raw`straatnaam|\bstraat\b`),
      rx(String.raw`line[\s_-]?2|address[\s_-]?2\b|рядок 2|linia 2|zeile 2|ligne 2|línea 2|riga 2|linha 2|regel 2|adresszusatz|complément|toevoeging`)],
    ["postalCode", rx(
      String.raw`\bzip|postal|post[\s_-]?code`, String.raw`індекс|поштовий код`, String.raw`kod pocztowy`, String.raw`\bplz\b|postleitzahl`,
      String.raw`code postal`, String.raw`código postal`, String.raw`\bcap\b|codice postale`, String.raw`\bcep\b`)],
    ["state", rx(
      String.raw`\bstate\b|province|\bregion\b`, String.raw`область|регіон`, String.raw`województwo`, String.raw`bundesland`,
      String.raw`région|département`, String.raw`provincia|\bestado\b|región`, String.raw`regione`, String.raw`distrito|província`,
      String.raw`provincie`),
      rx(String.raw`united states|statement|civil`)],
    ["city", rx(
      String.raw`\bcity\b|\btown\b`, String.raw`місто|населений пункт`, String.raw`miasto|miejscowość`,
      String.raw`\bstadt\b|\bort\b|wohnort`, String.raw`\bville\b`, String.raw`ciudad|localidad`, String.raw`città|\bcomune\b`,
      String.raw`cidade`, String.raw`woonplaats|\bplaats\b|\bstad\b`),
      rx(String.raw`country|county|країна|\bkraj\b|\bland\b|\bpays\b|\bpaís\b|\bpaese\b`)],
    ["location", rx(
      String.raw`location|where are you (currently )?(based|located)`,
      String.raw`місцезнаходження|локація|місце проживання|де ви (зараз )?(знаходитесь|проживаєте)`,
      String.raw`lokalizacja|miejsce zamieszkania`, String.raw`standort`, String.raw`localisation|lieu de résidence`, String.raw`ubicación`,
      String.raw`località|luogo di residenza`, String.raw`localização|local de residência`, String.raw`locatie`),
      rx(String.raw`country|county|zip|postal|line|relocat|релокац|переїзд|країна|\bkraj\b|\bpays\b|\bpaís\b|\bpaese\b`)],
    ["country", rx(
      String.raw`countr|residence|citizenship|nationality`, String.raw`країна|держава|громадянство`,
      String.raw`\bkraj\b|państwo|obywatelstwo`, String.raw`\bland\b|staatsangehörigkeit|nationalität`, String.raw`\bpays\b|nationalité`,
      String.raw`\bpaís\b|nacionalidad`, String.raw`\bpaese\b|nazione|cittadinanza|nazionalità`, String.raw`nacionalidade|cidadania`,
      String.raw`nationaliteit`),
      rx(String.raw`county|код країни|kod kraju|prefisso|landcode|código do país`)],
    ["currentCompany", rx(
      String.raw`current[\s_-]?(company|employer)|recent employer|^company( name)?\b|^employer\b`,
      String.raw`місце роботи|поточна компанія|^компанія\b|роботодавець`, String.raw`obecny pracodawca|^firma\b|pracodawca`,
      String.raw`arbeitgeber|^unternehmen\b`, String.raw`employeur|entreprise actuelle|^entreprise\b|^société\b`,
      String.raw`empresa actual|^empresa\b|empleador`, String.raw`azienda attuale|^azienda\b|datore di lavoro`,
      String.raw`empresa atual|empregador|entidade patronal`, String.raw`huidige werkgever|^werkgever\b|^bedrijf\b`)],
    ["currentTitle", rx(
      String.raw`current[\s_-]?(title|role|position|job title)|^(job )?title\b|^position\b`, String.raw`посада`, String.raw`stanowisko`,
      String.raw`berufsbezeichnung|jobtitel|aktuelle position`, String.raw`poste actuel|intitulé du poste|^fonction\b|^poste\b`,
      String.raw`^cargo\b|puesto actual|^puesto\b`, String.raw`ruolo attuale|qualifica`, String.raw`cargo atual|^função\b`,
      String.raw`functietitel|huidige functie|^functie\b`)],
    ["yearsOfExperience", rx(
      String.raw`years.{0,25}experience|experience.{0,10}years`, String.raw`рок(ів|и) досвіду|досвід(у)? роботи`,
      String.raw`lat doświadczenia|doświadczenie zawodowe`, String.raw`jahre.{0,20}erfahrung|berufserfahrung`,
      String.raw`(années|ans) d'expérience`, String.raw`años de experiencia`, String.raw`anni di esperienza`,
      String.raw`anos de experiência`, String.raw`jaren.{0,10}ervaring|werkervaring`),
      // "experience with React" is a skill question for the AI, not total experience.
      rx(String.raw`\b(with|using|з|із|w|mit|avec|con|com|met)\b`)],
    ["noticePeriod", rx(
      String.raw`notice`, String.raw`(період|термін) попередження|відпрацюван`, String.raw`okres wypowiedzenia`,
      String.raw`kündigungsfrist`, String.raw`préavis`, String.raw`preaviso`, String.raw`preavviso`, String.raw`aviso prévio|pré-aviso`,
      String.raw`opzegtermijn`)],
    ["startDate", rx(
      String.raw`start date|earliest start|when can you start|available to start|availability`,
      String.raw`дата (початку|виходу)|коли (ви )?можете (почати|приступити|вийти)|готовність (приступити|до виходу)`,
      String.raw`data rozpoczęcia|dostępność|kiedy możesz zacząć`, String.raw`eintrittsdatum|eintrittstermin|frühestmöglich|verfügbarkeit`,
      String.raw`date de (début|démarrage)|disponibilité`, String.raw`fecha de (inicio|incorporación)|disponibilidad`,
      String.raw`data di inizio|disponibilità`, String.raw`data de início|disponibilidade`,
      String.raw`startdatum|beschikbaarheid|wanneer kun je beginnen`)],
    ["salary", rx(
      String.raw`salary|compensation|pay expectation|desired pay|rate expectation`, String.raw`зарплат|заробітн|оплат[аи] праці`,
      String.raw`wynagrodzeni|pensj`, String.raw`gehalt|vergütung`, String.raw`salaire|rémunération|prétentions salariales`,
      String.raw`salario|salarial|sueldo|remuneración`, String.raw`retribuzione|stipendio`, String.raw`salário|remuneração`,
      String.raw`salaris|\bloon`)],
    ["englishLevel", rx(
      String.raw`english`, String.raw`англійськ`, String.raw`angielsk`, String.raw`englisch`, String.raw`anglais`, String.raw`inglés|ingles`,
      String.raw`inglese`, String.raw`inglês`, String.raw`\bengels\b`)],
    ["howDidYouHear", rx(
      String.raw`how did you (hear|find)|where did you (hear|find)|hear about`, String.raw`звідки (ви )?дізнал|як ви дізнал`,
      String.raw`skąd (się )?dowiedział|jak się dowiedział`, String.raw`wie (haben )?sie .{0,30}erfahren`,
      String.raw`comment avez-vous (connu|entendu)`, String.raw`cómo (te|se|nos) (enteró|enteraste|conociste)`,
      String.raw`come (hai|ha) (saputo|conosciuto)|come ci hai conosciuto`, String.raw`como (soube|conheceu|ficou a saber)`,
      String.raw`hoe (heb je|ben je|bent u|heeft u).{0,30}(gehoord|gevonden|terecht)`)],
    ["gender", rx(
      String.raw`gender|\bsex\b`, String.raw`\bстать\b|гендер`, String.raw`płeć`, String.raw`geschlecht`, String.raw`\bgenre\b|\bsexe\b`,
      String.raw`género|\bsexo\b`, String.raw`\bgenere\b|\bsesso\b`, String.raw`gênero`, String.raw`geslacht`)],
    ["ethnicity", rx(
      String.raw`\brace\b|ethnic|hispanic`, String.raw`етніч|\bраса\b`, String.raw`etniczn|\brasa\b`, String.raw`ethnisch`,
      String.raw`origine ethnique`, String.raw`\braza\b|etnia`, String.raw`origine etnica`, String.raw`\braça\b`, String.raw`etniciteit|etnische`)],
    ["veteran", rx(String.raw`veteran`, String.raw`ветеран`, String.raw`weteran`, String.raw`ancien combattant`, String.raw`veterano`, String.raw`veteraan`)],
    ["disability", rx(
      String.raw`disabilit`, String.raw`інвалідн`, String.raw`niepełnosprawn`, String.raw`behinderung`, String.raw`handicap`,
      String.raw`discapacidad`, String.raw`disabilità`, String.raw`deficiência`, String.raw`beperking`)]
  ];

  const COVER_LETTER_RE = rx(
    String.raw`cover[\s_-]?letter|coverletter|motivation letter`, String.raw`супровідн|мотиваційн(ий|ого) лист`,
    String.raw`list motywacyjny`, String.raw`anschreiben|motivationsschreiben`, String.raw`lettre de motivation`,
    String.raw`carta de (presentación|motivación)`, String.raw`lettera (di presentazione|motivazionale)`,
    String.raw`carta de (apresentação|motivação)`, String.raw`motivatiebrief|sollicitatiebrief`);
  const RESUME_RE = rx(
    String.raw`resume|\bcv\b|curriculum`, String.raw`резюме`, String.raw`życiorys`, String.raw`lebenslauf`,
    String.raw`currículum|hoja de vida`, String.raw`currículo`);

  const CONSENT_RE = rx(
    String.raw`privacy[\s_-]?policy`,
    String.raw`terms[\s_-]?(and|of)[\s_-]?(conditions|service|use)|\bterms\b`,
    String.raw`data[\s_-]?(storage|processing|protection|retention)|store[\s_-]?(my[\s_-]?)?personal[\s_-]?(details|data)|applicant[\s_-]?data`,
    String.raw`talent[\s_-]?pool`,
    String.raw`contact[\s_-]?(me[\s_-]?)?(directly[\s_-]?)?about[\s_-]?(specific[\s_-]?)?future[\s_-]?(job[\s_-]?)?opportunities|future[\s_-]?(job[\s_-]?)?opportunities`,
    String.raw`\bgdpr\b|\bcookie[s]?\b|newsletter[s]?`,
    String.raw`\bconsent\b|\bopt[\s_-]?in\b|agree[\s_-]?(that|to|with)|\bi agree\b`,
    String.raw`\banalytics\b`,
    String.raw`\bmarketing\b`,
    String.raw`згод[аи]|політик[аи] конфіденційності|персональн(их|і) дан`,
    String.raw`zgod[aę]|polityk[aę] prywatności|danych osobowych`,
    String.raw`datenschutz|einwillig|zustimm`,
    String.raw`confidentialité|consentement`,
    String.raw`privacidad|consentimiento`,
    String.raw`privacy|consenso`,
    String.raw`toestemming`
  );
  const LEGIT_CHECKBOX_RE = rx(
    String.raw`authori[sz]ed to work|legal(ly)? (right|authori[sz]ed)|right to work|eligible to work|work permit|work authori[sz]ation`,
    String.raw`дозв[іо]л на роботу|право на роботу|pozwoleni[ea] na pracę|prawo do pracy`,
    String.raw`arbeitserlaubnis|arbeitsgenehmigung|autorisation de travail|permis de travail`,
    String.raw`permiso de trabajo|autorización para trabajar|permesso di lavoro|autorizzat[oa] a lavorare`,
    String.raw`autorização de trabalho|autorizad[oa] a trabalhar|werkvergunning|bevoegd om te werken`,
    String.raw`sponsor|\bvisa\b|\bвіз[аиу]\b|\bwiz[ayę]\b|visum|parrainage|patrocinio|\bvisto\b|sponsorizzazione|patrocínio`,
    String.raw`relocat|релокац|переїзд|relokac|przeprowadz|umzug|umzieh|relokation|déménag|relocalis|mobilité géographique|reubica|traslad|trasferir|trasferimento|realoca|mudar-se|mudar de cidade|verhuiz`
  );

  // Descriptor for H.fhClassifyFileInput: own attributes plus the text of the nearest small wrapper
  // (so a generic "Attach" button is judged by the question it sits under, e.g. "Resume/CV").
  function fileDescriptor(el, fullId) {
    const attr = (n) => (el?.getAttribute ? el.getAttribute(n) || "" : "");
    let surroundingText = "";
    let node = el?.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const fields = node.querySelectorAll ? node.querySelectorAll("input, textarea, select").length : 0;
      if (fields > 2) break;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 3) surroundingText = text.slice(0, 160);
    }
    return {
      label: (fullId.split("|")[0] || "").trim(),
      ariaLabel: attr("aria-label"),
      name: attr("name"),
      id: attr("id"),
      placeholder: attr("placeholder"),
      accept: attr("accept"),
      surroundingText
    };
  }

  // Classify field: Tier 1 = resolvable from the profile (0 tokens), Tier 2 = needs an answer.
  function classifyField(fullId, type, el) {
    fullId = fullId.replace(/[’ʼ‘`]/g, "'");
    if (COVER_LETTER_RE.test(fullId)) {
      return { tier: 2, key: type === "file" ? "coverLetterFile" : "coverLetter" };
    }
    if (type === "file") {
      // Decide by label/name/accept/surrounding text: a "Photo" (jpg/png) input is never the resume.
      const fileClass = H.fhClassifyFileInput(fileDescriptor(el, fullId));
      return fileClass.passed || fileClass.weak
        ? { tier: 1, key: "resumeFile", fileClass }
        : { tier: 2, key: "otherFile", fileClass };
    }
    if (RESUME_RE.test(fullId)) {
      return { tier: 1, key: "resumeFile" };
    }

    const isCheckbox = type === "checkbox" || type === "toggle-checkbox-pair" || el?.type === "checkbox";
    const labelFirst = (fullId.split("|")[0] || "").trim().toLowerCase();
    const isExactConsentLabel = labelFirst === "analytics" || labelFirst === "marketing";
    if (
      !LEGIT_CHECKBOX_RE.test(fullId) &&
      isCheckbox && (CONSENT_RE.test(fullId) || isExactConsentLabel)
    ) {
      return { type: "consent" };
    }

    if (type !== "textarea") {
      const acToken = (el?.getAttribute?.("autocomplete") || "").trim().toLowerCase().split(/\s+/).pop();
      if (AUTOCOMPLETE_KEYS[acToken]) return { tier: 1, key: AUTOCOMPLETE_KEYS[acToken] };

      const subject = `${fullId} | type:${type}`;
      for (const [key, match, exclude] of FIELD_RULES) {
        if (!match.test(subject) || (exclude && exclude.test(subject))) continue;
        // A dropdown labelled "Phone" next to the number input is the country-code picker.
        if (key === "phone" && (type === "select" || type === "combobox")) return { tier: 1, key: "phoneDialCode" };
        return { tier: 1, key };
      }
    }

    // Learned Answers (self-learning custom profile answers) — checked LAST, as a fallback
    // only. A stale/wrong learned answer (e.g. saved once from a form that a DOM-write bug had
    // corrupted) must never be able to override a field we can already resolve authoritatively
    // from candidateData (email, phone, linkedin, etc.) — that field's OWN key always wins above.
    const learnedVal = findLearnedAnswer(fullId);
    if (learnedVal) {
      return { tier: 1, key: "learnedAnswer", learnedVal: learnedVal };
    }

    return { tier: 2, key: "dynamicAI" };
  }

  // Form language: Cyrillic or Polish letters in the labels beat <html lang>, which ATS pages
  // often leave as "en" regardless of content. Other Latin-script languages rely on <html lang>.
  function pageLanguage(fields) {
    const html = (document.documentElement.lang || "").slice(0, 2).toLowerCase();
    const text = fields.map((f) => f.label).join(" ");
    if (/[а-яіїєґ]/i.test(text)) return "uk";
    if (/[ąćęłńśźż]/i.test(text)) return "pl";
    return FORM_LANGUAGES[html] ? html : "en";
  }

  // Profile with `localized[lang]` values laid over the base ones.
  function withLocale(data, lang) {
    const loc = data.localized?.[lang];
    if (!loc) return data;
    const out = structuredClone(data);
    Object.entries(loc).forEach(([section, vals]) => {
      Object.entries(vals || {}).forEach(([k, v]) => {
        if (v) (out[section] = out[section] || {})[k] = v;
      });
    });
    return out;
  }

  // "Ukraine" ⇄ "Україна" ⇄ "Ucraina"...: every known name of the same country, built once
  // from the browser's own region names (Intl.DisplayNames) for all FORM_LANGUAGES.
  let regionNames = null;
  function countryNames(name) {
    if (!name) return [];
    if (!regionNames) {
      regionNames = new Map();
      const displays = Object.keys(FORM_LANGUAGES).map((l) => new Intl.DisplayNames([l], { type: "region", fallback: "none" }));
      for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 26; j++) {
          const code = String.fromCharCode(65 + i, 65 + j);
          const names = displays.map((d) => { try { return d.of(code); } catch (e) { return undefined; } }).filter(Boolean);
          names.forEach((n) => regionNames.set(normalizeQuestion(n), names));
        }
      }
    }
    return regionNames.get(normalizeQuestion(name)) || [];
  }

  // Values to try for a field, best first: the form-language translation, the base value,
  // then (for countries) the country's name in every supported language.
  function profileValues(key, data, profileKey, field, hasDialCodeField, lang) {
    const local = profileValue(key, withLocale(data, lang), profileKey, field, hasDialCodeField);
    const base = profileValue(key, data, profileKey, field, hasDialCodeField);
    const values = [local, base, ...(key === "country" ? countryNames(base) : [])].filter(Boolean);
    return [...new Set(values)];
  }

  const YES_NO_WORDS = {
    uk: ["Так", "Ні"], pl: ["Tak", "Nie"], de: ["Ja", "Nein"], fr: ["Oui", "Non"], es: ["Sí", "No"],
    it: ["Sì", "No"], pt: ["Sim", "Não"], nl: ["Ja", "Nee"]
  };
  let formLang = "en";

  // Free-text inputs get "Yes"/"No" in the form's language.
  function localizeYesNo(value) {
    const words = YES_NO_WORDS[formLang];
    if (!words) return value;
    return /^yes$/i.test(value) ? words[0] : /^no$/i.test(value) ? words[1] : value;
  }

  const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : v);

  function dialCodeOf(personal) {
    return personal.phoneCountryCode || (personal.phone || "").match(/^(\+\d{1,3})[\s-]/)?.[1] || "";
  }

  // Resolves a classification key to the profile value (empty → field is reported as missing).
  function profileValue(key, data, profileKey, field, hasDialCodeField) {
    const p = data.personal || {};
    const l = data.links || {};
    const w = data.work || {};
    const g = data.legal || {};
    const e = data.eeo || {};
    switch (key) {
      case "firstName": return p.firstName;
      case "lastName": return p.lastName;
      case "preferredName": return p.preferredName || p.firstName;
      case "fullName": return p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ");
      case "pronouns": return p.pronouns;
      case "email": return p.email;
      case "phoneDialCode": return dialCodeOf(p);
      case "phone": {
        const phone = p.phone || "";
        const dial = dialCodeOf(p);
        // A separate dial-code control (or a national-format placeholder) means only the national
        // number belongs in this input; otherwise send the full international number.
        const el = field.element;
        const nearDialControl = !!el.parentElement?.parentElement?.querySelector(
          'select, [role="combobox"], [class*="dial" i], [class*="flag" i], .iti__flag-container'
        );
        const nationalPlaceholder = /\d/.test(el.placeholder || "") && !(el.placeholder || "").includes("+");
        if (dial && (hasDialCodeField || nearDialControl || nationalPlaceholder)) {
          return phone.replace(dial, "").replace(dial.slice(1), "").trim().replace(/^0/, "");
        }
        return phone;
      }
      case "address": return p.address;
      case "city": return p.city;
      case "state": return p.state;
      case "postalCode": return p.postalCode;
      case "country": return p.country;
      case "location": return p.location || [p.city, p.country].filter(Boolean).join(", ");
      case "linkedin": return l.linkedin;
      case "github": return l.github;
      case "twitter": return l.twitter;
      case "website": return l.website || l.portfolio;
      case "currentCompany": return w.currentCompany;
      case "currentTitle": return data.profiles?.[profileKey]?.title || w.currentTitle;
      case "yearsOfExperience": return w.yearsOfExperience;
      case "noticePeriod": return w.noticePeriod;
      case "startDate": return w.startDate || w.noticePeriod;
      case "salary": return w.salaryExpectation;
      case "englishLevel": return w.englishLevel;
      case "howDidYouHear": return w.howDidYouHear;
      case "workAuthorization": return yesNo(g.authorizedToWork);
      case "sponsorship": return yesNo(g.requiresSponsorship);
      case "relocation": return yesNo(g.willingToRelocate);
      // Empty EEO answers default to "decline to self-identify".
      case "gender": return e.gender || "decline";
      case "ethnicity": return e.ethnicity || "decline";
      case "veteran": return e.veteran || "decline";
      case "disability": return e.disability || "decline";
    }
    return null;
  }

  function isFilled(field) {
    const el = field.element;
    if (field.type === "radio-group" || field.type === "checkbox-group") return field.options.some((o) => o.element?.checked);
    if (field.type === "toggle-checkbox-pair") return false;
    if (el.type === "checkbox") return el.checked;
    if (el.type === "file") return !!el.files?.length;
    if (el.tagName === "SELECT") return !!el.value && el.selectedIndex > 0;
    return !!String(el.value ?? "").trim();
  }

  // Writes a value into any supported field type. Shared by Tier-1 autofill and AI injection.
  // `value` may be a list of alternatives (best first): choices try each, text uses the first.
  async function fillField(field, value) {
    const el = field.element;
    const rawValue = Array.isArray(value) ? value[0] : value;
    const isClearRequest = rawValue === "";
    
    // For non-empty values, filter as before
    const values = isClearRequest 
      ? [""] 
      : [...new Set((Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean))];
    
    if (!values.length) return false;
    const ans = values[0];
    const pick = (texts) => {
      for (const v of values) {
        const i = pickOption(texts, v);
        if (i >= 0) return i;
      }
      return -1;
    };

    if (field.type === "toggle-checkbox-pair") {
      // Ashby Yes/No pair over a hidden checkbox: a click TOGGLES, so read fresh state first.
      const wantsYes = YES_RE.test(ans);
      const input = field.underlyingInput;
      const btn = wantsYes ? field.yesButton : field.noButton;
      const already = input
        ? input.checked === wantsYes
        : btn.getAttribute("aria-pressed") === "true" || btn.classList.contains("selected") || btn.classList.contains("active");
      if (!already) dispatchUserClick(btn);
      return true;
    }

    if (field.type === "checkbox-group") {
      // Multi-select: option labels may contain commas, so try the whole answer first, then split on
      // newline / ';' / ' | ' (or a JSON array). "" clears every option.
      const labels = field.options.map((o) => o.label);
      const wanted = new Set();
      if (!isClearRequest) {
        const whole = pickOption(labels, ans);
        let parts = [];
        if (whole >= 0 && String(labels[whole]).trim().toLowerCase() === ans.trim().toLowerCase()) parts = [ans];
        else if (ans.trim().startsWith("[")) {
          try {
            parts = JSON.parse(ans).map(String);
          } catch (e) {
            parts = [];
          }
        }
        if (!parts.length) parts = ans.split(/\n|;|\s\|\s/).map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
          const i = pickOption(labels, part);
          if (i >= 0) wanted.add(i);
        }
        if (!wanted.size) return false;
      }
      field.options.forEach((o, i) => setNativeChecked(o.element, wanted.has(i)));
      return true;
    }

    if (field.type === "radio-group") {
      const i = pick(field.options.map((o) => o.label));
      if (i < 0) return false;
      setNativeChecked(field.options[i].element, true);
      return true;
    }

    if (el.tagName === "SELECT") {
      const opts = Array.from(el.options);
      const i = pick(opts.map((o) => (o.value ? o.text : "")));
      if (i < 0) return false;
      el.selectedIndex = i;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.setAttribute("data-autofill-highlight", "1");
      return true;
    }

    // Handle empty string: clear text-like fields (no consent/checkbox/file clearing)
    if (ans === "") {
      if (el.type === "checkbox" || el.type === "radio" || el.type === "file") return false;
      if (field.type === "consent" || field.classification?.type === "consent") return false;
      if (field.type === "radio-group" || field.type === "toggle-checkbox-pair") return false;
      if (el.tagName === "SELECT") {
        el.selectedIndex = 0;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.setAttribute("data-autofill-highlight", "1");
        return true;
      }
      // For text/textarea/contenteditable, clear the value
      replaceFieldValue(el, "");
      return true;
    }


    if (field.type === "consent" || field.classification?.type === "consent") return false;

    if (el.type === "checkbox") {
      setNativeChecked(el, YES_RE.test(ans));
      return true;
    }

    if (isComboboxEl(el) || ["country", "phoneDialCode"].includes(field.classification?.key)) {
      // Each miss waits for async options, so only the top few alternatives are tried.
      for (const v of values.slice(0, 3)) {
        if (await selectComboboxOption(el, v)) return true;
      }
      return false;
    }

    // "decline" only makes sense as a dropdown choice, never as typed text.
    if (ans === "decline") return false;
    setHumanLikeValue(el, localizeYesNo(ans));
    return true;
  }

  // Fill Tier 1 (Static) fields with human-like staggered delays.
  // Never overwrites a field that already has a value (user edits win).
  // Waits while the page is busy parsing/importing the uploaded resume (Ashby: "Parsing your resume.
  // Autofilling key fields..."): that step overwrites form fields, so filling before it ends is lost.
  async function waitForSettle(timeoutMs = 10000) {
    const busy = /parsing (your )?resume|autofilling (key )?fields|importing (your )?(resume|profile)/i;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!busy.test((document.body?.innerText || "").slice(0, 6000))) return true;
      await sleep(250);
    }
    return false;
  }

  // One Tier-1 pass. retry=true: only fields that became empty again are written, and they are listed in
  // report.refilled instead of report.filled. Returns how many fields it wrote.
  async function fillStaticPass(data, profileKey, report, retry) {
    const fields = scanFormFields();
    const hasDialCodeField = fields.some((f) => f.classification.key === "phoneDialCode");
    formLang = pageLanguage(fields);
    let resumeAttached = false;
    let changed = 0;

    // Several file inputs: the resume goes only into a confidently identified one (never "Photo"/"Video").
    const fileFields = fields.filter((f) => f.classification.key === "resumeFile");
    const weakFiles = fileFields.filter((f) => f.classification.fileClass?.weak);
    // Every confidently identified resume input gets the file (Ashby has both an "Autofill from resume"
    // dropzone and a required "Resume" field); an unlabeled input only when it is the single candidate.
    const passedFiles = fileFields.filter((f) => f.classification.fileClass?.passed);
    const chosenResumes = new Set(
      passedFiles.length
        ? passedFiles
        : weakFiles.length === 1
          ? weakFiles
          : fileFields.length === 1 && !fileFields[0].classification.fileClass
            ? fileFields
            : []
    );

    for (const field of fields) {
      if (field.type === "consent" || field.classification?.type === "consent") continue;
      const { tier, key, learnedVal } = field.classification;
      if (tier !== 1 || isFilled(field)) continue;
      const entry = { label: field.label, key };

      if (key === "resumeFile") {
        if (!chosenResumes.has(field)) {
          if (!retry && !chosenResumes.size && !report.failed.some((f) => f.key === "resumeFile")) {
            report.failed.push({ ...entry, reason: "no confident resume file input (labels/accept did not identify a resume field)" });
          }
          continue;
        }
        const el = field.element;
        const fileInput = el.type === "file"
          ? el
          : el.querySelector?.('input[type="file"]') ||
            el.closest(".MuiFormControl-root, [class*='upload'], [class*='resume']")?.querySelector('input[type="file"]');
        if (!fileInput || fileInput.files?.length) continue;
        const attached = await attachResumeFile(fileInput, profileKey);
        resumeAttached = resumeAttached || attached;
        if (attached) {
          changed++;
          (retry ? report.refilled : report.filled).push(retry ? field.label : entry);
        } else if (!retry) {
          report.failed.push(entry);
        }
        continue;
      }

      const value = key === "learnedAnswer" ? [learnedVal] : profileValues(key, data, profileKey, field, hasDialCodeField, formLang);
      if (!value.length) {
        if (!retry) report.missingProfile.push(entry);
        continue;
      }
      if (await fillField(field, value)) {
        changed++;
        (retry ? report.refilled : report.filled).push(retry ? field.label : entry);
      } else if (!retry) {
        report.failed.push({ ...entry, value: value[0] });
      }

      // Small natural micro-delay between fields to avoid instantaneous bot detection
      await sleep(25 + Math.random() * 35);
    }

    // Deel/MUI-style "Upload your resume" button that only mounts its <input type=file> on click.
    if (!retry && !resumeAttached && !fields.some((f) => f.classification.key === "resumeFile")) {
      const resumeBtn = Array.from(document.querySelectorAll("button, [role='button']")).find((b) => {
        const text = (b.textContent || "").toLowerCase();
        const parentText = (b.closest(".MuiListItem-root, [class*='DeelUI'], [class*='upload']")?.textContent || "").toLowerCase();
        return (text.includes("upload") && /resume|\bcv\b/.test(parentText)) || parentText.includes("upload your resume");
      });
      if (resumeBtn) {
        resumeBtn.click();
        await sleep(200);
        const fileInput = document.querySelector('input[type="file"]');
        const fileClass = fileInput ? H.fhClassifyFileInput(fileDescriptor(fileInput, "")) : null;
        if (fileInput && (fileClass.passed || fileClass.weak) && !fileInput.files?.length && (await attachResumeFile(fileInput, profileKey))) {
          report.filled.push({ label: "Resume", key: "resumeFile" });
        }
      }
    }
    return changed;
  }

  async function autofillStaticFields(data, profileKey) {
    if (!data) data = candidateData || DEFAULT_CANDIDATE_DATA;
    const report = { filledCount: 0, filled: [], missingProfile: [], failed: [], refilled: [] };

    await waitForSettle();
    await fillStaticPass(data, profileKey, report, false);

    // Pages that parse the resume after upload can wipe what was just filled: re-check and refill (max 2 passes).
    for (let pass = 0; pass < 2; pass++) {
      await sleep(800);
      await waitForSettle(5000);
      if (!(await fillStaticPass(data, profileKey, report, true))) break;
    }

    report.filledCount = report.filled.length;
    report.language = formLang;
    return report;
  }

  // Extract Job Context and Unfilled Questions for AI
  function extractJobAndQuestions(full = false) {
    const fields = scanFormFields();
    const platform = detectPlatform();

    // Clean extraction of Job Title & Company
    let jobTitle = "";
    let company = "";

    // Ashby specific title & company
    const ashbyHeader = document.querySelector('[class*="job-posting-header"], [class*="_headerContainer_"]');
    if (ashbyHeader) {
      const h1 = ashbyHeader.querySelector("h1");
      if (h1) jobTitle = h1.innerText.trim();
    }

    // Greenhouse specific
    const ghAppTitle = document.querySelector(".app-title, #header .title, h1.app-title");
    const ghCompany = document.querySelector(".company-name, #header .company-name");
    if (ghAppTitle) jobTitle = ghAppTitle.innerText.trim();
    if (ghCompany) company = ghCompany.innerText.trim();

    // Lever specific
    const leverPosting = document.querySelector(".posting-headline h2");
    if (leverPosting) jobTitle = leverPosting.innerText.trim();

    // General fallback
    if (!jobTitle) {
      const h1 = document.querySelector("h1");
      if (h1) jobTitle = h1.innerText.trim();
      else jobTitle = document.title;
    }

    if (!company) {
      const hostParts = window.location.hostname.split(".");
      if (hostParts.length >= 2) {
        company = hostParts[0] === "jobs" || hostParts[0] === "boards" ? hostParts[1] : hostParts[0];
      }
      company = company.charAt(0).toUpperCase() + company.slice(1);
    }

    // Extract clean job description (stripping scripts, styles, header, footer)
    const contentClone = document.body.cloneNode(true);
    const toRemove = contentClone.querySelectorAll(
      "script, style, nav, footer, header, svg, noscript, iframe, .jff-floating-banner"
    );
    toRemove.forEach((el) => el.remove());

    let rawText = contentClone.innerText.replace(/\n\s*\n/g, "\n").trim();
    // Trim to reasonable length (~2000 chars) to save max tokens while preserving requirements
    const maxLength = full ? 30000 : 3000;
    const trimmedJobDescription = rawText.slice(0, maxLength);

    // Only extract Tier 2 (Dynamic) or unfilled required questions (exclude file uploads as they are handled locally, exclude consent checkboxes)
    const dynamicQuestions = fields
      .filter((f) => (f.classification.tier === 2 || f.required) && !isFilled(f) && f.type !== "file" && f.classification.key !== "resumeFile" && f.type !== "consent" && f.classification?.type !== "consent")
      .map((f) => ({
        fieldId: f.fieldId,
        label: f.label,
        type: f.type,
        required: f.required,
        // Known profile key (e.g. "salary") when the profile simply lacks the value.
        ...(f.classification.tier === 1 && { profileKey: f.classification.key }),
        ...(f.options?.length && { options: f.options.map((o) => o.label || o.text).filter(Boolean) }),
        ...(f.placeholder && { placeholder: f.placeholder })
      }));

    return {
      platform,
      url: window.location.href,
      jobTitle,
      company,
      jobDescription: trimmedJobDescription,
      // Answer in this language (the form's, from its labels / <html lang>).
      language: pageLanguage(fields),
      questions: dynamicQuestions,
      staticFilledCount: fields.filter((f) => f.classification.tier === 1 && f.value).length,
      totalFieldsCount: fields.length
    };
  }

  // Inject AI Answers into page fields with stealth human delays.
  // Keys may be fieldId (preferred), selector, label, name or id.
  async function injectAIAnswers(answers) {
    if (!answers || typeof answers !== "object") return { success: false };

    const fields = scanFormFields();
    formLang = pageLanguage(fields);
    const filled = [];
    const notFound = [];
    const failed = [];

    for (const [ref, answer] of Object.entries(answers)) {
      if (answer === undefined || answer === null) continue;
      const refNorm = normalizeQuestion(ref);
      let field = fields.find(
        (f) => f.fieldId === ref || f.selector === ref || f.name === ref || f.id === ref || normalizeQuestion(f.label) === refNorm
      );
      if (!field) {
        let el = null;
        try {
          el = document.querySelector(ref);
        } catch (e) {}
        if (el) field = { element: el, type: el.type, label: ref, classification: {} };
      }
      if (!field) {
        notFound.push(ref);
        continue;
      }
      if (await fillField(field, answer)) filled.push(ref);
      else failed.push(ref);
      await sleep(35 + Math.random() * 35);
    }

    // Each frame only sees its own fields, so notFound is per-frame; the caller merges frames.
    return { success: true, aiFilledCount: filled.length, filled, failed, notFound };
  }

  // Current human-readable value of a scanned field ("" when empty or not representable).
  function currentValue(f) {
    const el = f.element;
    if (f.type === "radio-group") return f.options.find((o) => o.element?.checked)?.label?.trim() || "";
    if (f.type === "checkbox-group") return f.options.filter((o) => o.element?.checked).map((o) => o.label).join("; ");
    if (f.type === "toggle-checkbox-pair" || el.type === "file") return "";
    if (el.tagName === "SELECT") return el.value ? el.options[el.selectedIndex]?.text.trim() || "" : "";
    // An unchecked checkbox may just be unanswered, so only "Yes" is learned.
    if (el.type === "checkbox") return el.checked ? "Yes" : "";
    return String(el.value ?? "").trim();
  }

  // Every field of the application form with its CURRENT value (filled and empty), so a caller can verify
  // what is really in the form after autofill / resume re-parsing. Passwords are masked, files show names.
  function getFormState(maxValueLength = 120, includeEmpty = true) {
    const cut = (s) => (s.length > maxValueLength ? s.slice(0, maxValueLength) + "…" : s);
    const out = [];
    for (const f of scanFormFields()) {
      const el = f.element;
      const filled = isFilled(f);
      if (!filled && !includeEmpty) continue;
      let value = "";
      if (el.type === "password") value = filled ? "••••" : "";
      else if (el.type === "file") value = Array.from(el.files || []).map((x) => x.name).join(", ");
      else if (f.type === "checkbox-group") value = f.options.filter((o) => o.element?.checked).map((o) => o.label).join(", ");
      else if (el.type === "checkbox") value = el.checked ? "checked" : "unchecked";
      else if (f.type === "toggle-checkbox-pair") value = f.underlyingInput ? (f.underlyingInput.checked ? "Yes" : "No") : "";
      else value = currentValue(f);
      out.push({
        fieldId: f.fieldId,
        label: f.label || "",
        type: f.type,
        required: !!f.required,
        filled,
        value: cut(String(value || ""))
      });
    }
    return out;
  }

  // Normalizes a value read from a form before it goes into the profile; "" rejects it.
  function profileValueFromForm(key, value) {
    if (["workAuthorization", "sponsorship", "relocation"].includes(key)) {
      return YES_RE.test(value) ? "Yes" : NO_RE.test(value) ? "No" : value;
    }
    if (key === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
    if (["linkedin", "github", "twitter", "website"].includes(key)) return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(value) ? value : "";
    if (key === "phoneDialCode") return value.match(/\+\d{1,4}/)?.[0] || "";
    // "Україна" / "Ukraina" → "Ukraine": the profile keeps one canonical (English) country name.
    if (key === "country") return countryNames(value)[0] || value;
    return value;
  }

  // Reads a form the user filled by hand:
  // - standard fields → profilePatch (merged into the profile by the popup, empty slots only);
  // - custom questions → answers (learned answers, replayed on similar questions later).
  // Standard fields are NOT stored as learned answers: the profile is their single source.
  function extractCurrentAnswers() {
    const fields = scanFormFields();
    const answers = {};
    const profilePatch = {};

    fields.forEach((f) => {
      const value = currentValue(f);
      if (!value || value.length > 5000) return;
      const { key, tier } = f.classification;

      if (PROFILE_KEY_PATHS[key]) {
        const v = profileValueFromForm(key, value);
        if (v && !getPath(profilePatch, PROFILE_KEY_PATHS[key])) setPath(profilePatch, PROFILE_KEY_PATHS[key], v);
        return;
      }
      if (key === "fullName") {
        const [first, ...rest] = value.split(/\s+/);
        if (!getPath(profilePatch, "personal.firstName")) setPath(profilePatch, "personal.firstName", first);
        if (rest.length && !getPath(profilePatch, "personal.lastName")) setPath(profilePatch, "personal.lastName", rest.join(" "));
        return;
      }
      // Other standard fields (location, EEO, resume) are derived from the profile or defaults.
      if (f.type === "consent" || f.classification?.type === "consent") return;
      if (tier === 1 && key !== "learnedAnswer") return;
      if (!f.label || isGenericPlaceholder(f.label)) return;
      answers[f.label] = value;
    });

    // A separate dial-code control means the number field held only the national part.
    const dial = profilePatch.personal?.phoneCountryCode;
    const phone = profilePatch.personal?.phone;
    if (dial && phone && !phone.startsWith("+")) profilePatch.personal.phone = `${dial} ${phone.replace(/^0/, "")}`;

    return { answers, profilePatch, language: pageLanguage(fields) };
  }

  // Verification helper: Checks page headline/banner for application success without full rescanning
  function getSubmissionStatus(tabUrl) {
    const text = document.body ? document.body.innerText.slice(0, 5000) : "";
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, [role='alert'], [class*='success'], [class*='confirmation']"))
      .map((el) => el.innerText.trim())
      .filter((t) => t.length > 0 && t.length < 150);

    const successKeywords = [
      /application\s+(?:submitted|received|complete)/i,
      /thank\s+you\s+for\s+applying/i,
      /thanks\s+for\s+applying/i,
      /we(?:'ve|\s+have)\s+received\s+your\s+application/i,
      /your\s+application\s+has\s+been\s+sent/i,
      /successfully\s+submitted/i,
      /дякуємо|заявк[уа] (успішно )?(надіслано|отримано|відправлено)/i,
      // Djinni-specific success phrases (item 5)
      /джин відправив ваш відгук/i,
      /ви вже відгукнулись на цю вакансію/i,
      /dziękujemy|aplikacja (została )?(wysłana|przesłana)/i,
      /vielen dank|bewerbung (ist )?(eingegangen|erhalten|versendet)/i,
      /merci (pour|de) votre candidature|candidature (a été )?(envoyée|reçue)/i,
      /gracias por (tu|su) (solicitud|postulación|candidatura)/i,
      /grazie per (la tua |la sua )?candidatura|candidatura (inviata|ricevuta)/i,
      /obrigad[oa] pela (sua )?candidatura|candidatura (enviada|recebida)/i,
      /bedankt voor (je|uw) sollicitatie|sollicitatie (is )?(ontvangen|verzonden)/i
    ];

    // Djinni-specific URL detection: ?applied=ok
    const resolvedUrl = tabUrl || window.location.href;
    const djinniAppliedUrl = /[?&]applied=ok/.test(resolvedUrl) &&
      (/djinni\.co/i.test(resolvedUrl));

    const textHit = successKeywords.some((pattern) => pattern.test(text) || headings.some((h) => pattern.test(h)));
    const urlHit = H.fhSubmissionByUrl(resolvedUrl) || djinniAppliedUrl;
    const isSubmitted = urlHit || textHit;

    // Djinni: already-applied block is a distinct state from the post-submit banner
    const alreadyApplied = /ви вже відгукнулись на цю вакансію/i.test(text) && !djinniAppliedUrl;

    const matchedHeading = headings.find((h) => successKeywords.some((p) => p.test(h))) || (isSubmitted ? "Application Submitted" : null);

    return {
      isSubmitted,
      ...(alreadyApplied ? { alreadyApplied: true } : {}),
      matchedBy: urlHit ? "url" : textHit ? "text" : null,
      headline: matchedHeading || (headings[0] || ""),
      url: window.location.href,
      headings: headings.slice(0, 5)
    };
  }

  // click_button: advances NAVIGATION only. The requested label must EXACTLY equal an allowlisted label, and the
  // button that would be clicked must itself not look like a final/destructive action (checked on its text,
  // aria-label and value). Final submit is always the user's click.
  const NAV_ALLOWED = [
    "continue", "next", "save and continue", "save & continue", "start application", "apply now",
    "продовжити", "далі", "зберегти й продовжити", "зберегти та продовжити",
    "weiter", "continuer", "siguiente", "avançar"
  ];
  // Djinni-only navigation labels: these open the apply form / reveal salary input on djinni.co.
  // They are NOT added to the global NAV_ALLOWED to avoid accidentally clicking them on other sites
  // where similar Ukrainian text might appear. clickButton checks isDjinniVacancyPage() before
  // accepting them.
  const DJINNI_NAV_ALLOWED = [
    "відгукнутися на вакансію",  // opens the inline apply form (safe: does NOT submit)
    "змінити для цієї вакансії"  // reveals the per-vacancy salary override input
    // "надіслати відгук" is the FINAL SUBMIT — intentionally ABSENT here
  ];
  const NAV_DENIED_RE = /submit|\bsend\b|надіслати|відправити|подати заявку|\bapply\b(?!\s+now)|confirm|finish|complete|delete|withdraw|remove|discard|\bpay\b|\bbuy\b|place order|відкликати|видалити|оплатити/i;

  function clickButton(text) {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = norm(text);
    if (!wanted) return { success: false, denied: true, reason: "No button text provided", allowed: NAV_ALLOWED };

    // Check global allowlist first
    const globalAllowed = NAV_ALLOWED.includes(wanted);

    // Check Djinni-specific allowlist — only valid on a Djinni vacancy page
    const djinniAllowed = DJINNI_NAV_ALLOWED.includes(wanted) && isDjinniVacancyPage();

    if (!globalAllowed && !djinniAllowed) {
      // "надіслати відгук" (final submit) hits NAV_DENIED_RE → report denied:true
      if (NAV_DENIED_RE.test(wanted)) {
        return { success: false, denied: true, reason: `"${text}" is not an allowed navigation label`, allowed: NAV_ALLOWED };
      }
      return { success: false, denied: true, reason: `"${text}" is not an allowed navigation label`, allowed: NAV_ALLOWED };
    }

    // Djinni: the opener buttons sit OUTSIDE the (hidden) #apply_form that the generic scope would pick.
    const scope = djinniAllowed ? document : (H.fhGetApplicationScope(document) || document);
    const buttons = Array.from(scope.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a[role='button']"));
    const labelsOf = (b) => [b.innerText || b.textContent, b.getAttribute("aria-label"), b.value].map(norm).filter(Boolean);
    const visible = (b) => {
      const st = window.getComputedStyle(b);
      return st.display !== "none" && st.visibility !== "hidden" && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    };

    const matches = buttons.filter((b) => labelsOf(b).includes(wanted));
    if (!matches.length) return { success: false, denied: false, reason: `Button "${text}" not found` };

    const safe = matches.filter((b) => visible(b) && !labelsOf(b).some((l) => NAV_DENIED_RE.test(l)));
    if (!safe.length) {
      const refused = matches.some((b) => labelsOf(b).some((l) => NAV_DENIED_RE.test(l)));
      return {
        success: false,
        denied: refused,
        reason: refused ? `A matching button also looks like a final or destructive action; not clicked` : `Button "${text}" is hidden or disabled`
      };
    }
    dispatchUserClick(safe[0]);
    return { success: true, clicked: true, label: norm(labelsOf(safe[0])[0]) };
  }

  // Chrome Message Listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "PING":
        sendResponse({ pong: true });
        break;

      case "SCAN_FIELDS":
        sendResponse(scanFormFields());
        break;

      case "AUTOFILL_STATIC":
        loadCandidateData(async () => {
          const result = await autofillStaticFields(message.candidateData, message.activeProfileKey ?? activeProfileKey);
          sendResponse(result);
        });
        return true; // Keep message channel open for async response

      case "GET_JOB_AND_QUESTIONS":
        // Djinni list page: return notAVacancyPage instead of the ~250 country-filter options
        if (isDjinniListPage()) {
          sendResponse({ notAVacancyPage: true, reason: "Djinni jobs list/filter page — open a specific vacancy URL (/jobs/<id>-<slug>/) first." });
        } else if (isDjinniVacancyPage()) {
          // On a Djinni vacancy page, return the inline form state
          sendResponse(getDjinniFormState());
        } else {
          sendResponse(extractJobAndQuestions(message.full));
        }
        break;

      case "GET_ACTIVE_FORM":
        // Bridge sends GET_ACTIVE_FORM for get_active_job_form MCP tool
        if (isDjinniListPage()) {
          sendResponse({ notAVacancyPage: true, reason: "Djinni jobs list/filter page — open a specific vacancy URL (/jobs/<id>-<slug>/) first." });
        } else if (isDjinniVacancyPage()) {
          sendResponse(getDjinniFormState());
        } else {
          sendResponse(extractJobAndQuestions(message.full));
        }
        break;

      case "FILL_FORM":
        // Djinni: handle Djinni-specific fields directly
        if (isDjinniVacancyPage()) {
          sendResponse(fillDjinniForm(message.answers));
        } else {
          injectAIAnswers(message.answers).then((injectResult) => {
            sendResponse(injectResult);
          });
          return true;
        }
        break;

      case "GET_FORM_STATE":
        sendResponse({ fields: getFormState(message.maxValueLength, message.includeEmpty !== false) });
        break;

      case "GET_SUBMISSION_STATUS":
        sendResponse(getSubmissionStatus(message.tabUrl));
        break;

      case "INJECT_AI_ANSWERS":
        // background.js FILL_FORM sends INJECT_AI_ANSWERS, so the Djinni path must live here too.
        if (isDjinniVacancyPage()) {
          sendResponse(fillDjinniForm(message.answers));
          break;
        }
        injectAIAnswers(message.answers).then((injectResult) => {
          sendResponse(injectResult);
        });
        return true; // Keep message channel open for async response

      case "EXTRACT_CURRENT_ANSWERS":
        sendResponse(extractCurrentAnswers());
        break;

      case "CLICK_BUTTON":
        sendResponse(clickButton(message.text));
        break;

      case "UPDATE_PROFILE":
        activeProfileKey = message.activeProfileKey;
        if (message.candidateData) candidateData = message.candidateData;
        if (message.learnedAnswers) learnedAnswers = message.learnedAnswers;
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: "Unknown action" });
    }
  });

  // Test-only export (no-op in the real extension: module is undefined there).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { classifyField, replaceFieldValue, getDjinniFormState, fillDjinniForm, isDjinniVacancyPage, isDjinniListPage, getSubmissionStatus };
  }
})();
