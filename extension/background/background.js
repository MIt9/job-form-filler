/**
 * Job Form Filler - Background Service Worker
 * Manages WebSocket bridge connection and routes commands between Local Bridge and Content Scripts.
 */

importScripts("../shared/default-profile.js"); // mergeProfile, PROFILE_FIELDS
importScripts("../shared/tab-pick.js"); // jffPickBestTab

const BRIDGE_WS_URL = "ws://127.0.0.1:8765/ws";
const BRIDGE_HTTP_URL = "http://127.0.0.1:8765/api";

let ws = null;
let isConnected = false;
let isConnecting = false;

function isValidHttpUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;
  try {
    const parsed = new URL(urlString.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let timer = null;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const done = () => {
      cleanup();
      resolve();
    };

    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") {
        done();
      }
    };

    const onRemoved = (removedId) => {
      if (removedId === tabId) {
        done();
      }
    };

    timer = setTimeout(done, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") {
        done();
      }
    }).catch(() => {
      done();
    });
  });
}

// Check if Bridge HTTP server is alive before opening WebSocket (prevents ERR_CONNECTION_REFUSED spam)
async function isServerAlive() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${BRIDGE_HTTP_URL}/status`, {
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timer);
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Connect to Local Bridge WebSocket
async function connectBridge() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
    return;
  }

  isConnecting = true;

  const alive = await isServerAlive();
  if (!alive) {
    isConnecting = false;
    if (isConnected) {
      isConnected = false;
      chrome.storage.local.set({ bridgeConnected: false });
      broadcastStatus(false);
    }
    return;
  }

  try {
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }

    ws = new WebSocket(BRIDGE_WS_URL);

    ws.onopen = () => {
      console.log("[JFF Background] Connected to Local Bridge WebSocket");
      isConnected = true;
      isConnecting = false;
      chrome.storage.local.set({ bridgeConnected: true });
      broadcastStatus(true);
      syncProfilesFromBridge();
      // Send periodic ping to keep SW alive (MV3 kills idle workers after ~30s)
      startWsPing();
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        handleBridgeMessage(message);
      } catch (err) {
        console.error("[JFF Background] Error parsing WS message:", err);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      isConnecting = false;
      chrome.storage.local.set({ bridgeConnected: false });
      broadcastStatus(false);
      ws = null;
    };

    ws.onerror = () => {
      isConnected = false;
      isConnecting = false;
      chrome.storage.local.set({ bridgeConnected: false });
      broadcastStatus(false);
    };
  } catch (err) {
    isConnected = false;
    isConnecting = false;
  }
}

// Keep MV3 Service Worker alive: ping WS every 20s
let wsPingInterval = null;
function startWsPing() {
  if (wsPingInterval) clearInterval(wsPingInterval);
  wsPingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "ping" })); } catch (e) {}
    } else {
      clearInterval(wsPingInterval);
      wsPingInterval = null;
    }
  }, 20000);
}

// Broadcast connection status to popup
function broadcastStatus(connected) {
  chrome.runtime.sendMessage({ action: "BRIDGE_STATUS", connected }).catch(() => {});
}

// Fetch optional role variants from the bridge (RESUME_REPO_PATH). Personal data is never
// synced from the bridge: the popup-edited `candidateData` in storage is the single source of truth.
async function syncProfilesFromBridge() {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/profiles`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.profiles) {
        const bridgeProfiles = {};
        Object.values(data.profiles).forEach(({ id, title, summary }) => {
          bridgeProfiles[id] = { id, title, summary };
        });
        chrome.storage.local.set({ bridgeProfiles });
        console.log("[JFF Background] Synced profiles from bridge successfully");
      }
    }
  } catch (err) {
    console.log("[JFF Background] Local bridge profile sync skipped:", err.message);
  }
}

// Helper: Ensure content script is injected even on pre-existing tabs
async function ensureContentScriptInjected(tab) {
  if (!tab || !tab.id) return false;

  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://") || url.startsWith("view-source:") || url.startsWith("about:")) {
    throw new Error("Target tab is a browser system page where scripts cannot run.");
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
    throw new Error(
      "Failed to inject content script: " + err.message +
        " (enable 'Work on any website' in the extension popup Settings tab, then reload the tab)"
    );
  }
}

// Broadcast to all frames in the active tab (handles iframe embedded ATS)
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


// Handle incoming commands from AGY / Claude Code via Bridge
async function handleBridgeMessage(message) {
  const { command, requestId, payload } = message;

  // Target the active tab of the OS-focused window. OPEN_JOB_URL / FOCUS_TAB focus their
  // window, so later commands land on that tab without any sticky tab id.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

  // Profile and tab navigation commands don't need a pre-existing active tab.
  if (!activeTab?.id && !["GET_PROFILE", "SET_PROFILE", "OPEN_JOB_URL", "FOCUS_TAB"].includes(command)) {
    sendBridgeResponse(requestId, { error: "No active tab found in Chrome" });
    return;
  }

  try {
    if (command === "OPEN_JOB_URL") {
      const { url } = payload || {};
      if (!isValidHttpUrl(url)) {
        sendBridgeResponse(requestId, {
          error: `Invalid URL: Only http and https URLs are allowed (got "${url}")`
        });
        return;
      }

      const cleanUrl = url.trim();
      const tab = await chrome.tabs.create({ url: cleanUrl, active: true });
      if (tab.windowId) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (e) {}
      }

      await waitForTabComplete(tab.id, 15000);

      let finalUrl = tab.url || cleanUrl;
      try {
        const updated = await chrome.tabs.get(tab.id);
        if (updated?.url) finalUrl = updated.url;
      } catch (e) {}

      sendBridgeResponse(requestId, {
        success: true,
        data: {
          tabId: tab.id,
          windowId: tab.windowId,
          url: finalUrl
        }
      });
    } else if (command === "FOCUS_TAB") {
      const { tabId, urlSubstring } = payload || {};
      if (tabId == null && !urlSubstring) {
        sendBridgeResponse(requestId, { error: "Either tabId or urlSubstring must be provided" });
        return;
      }

      let target = null;
      let matchCount = 1;
      const numericId = tabId != null ? Number(tabId) : null;
      if (numericId != null && !Number.isNaN(numericId)) {
        try {
          const tab = await chrome.tabs.get(numericId);
          if (tab && (!urlSubstring || (tab.url && tab.url.includes(urlSubstring)))) {
            target = tab;
          }
        } catch (e) {}
      }

      if (!target && urlSubstring && typeof urlSubstring === "string") {
        const tabs = await chrome.tabs.query({});
        // ITEM D FIX: Use pickBestTab to select from candidates (prefers non-extension tabs, active window, highest ID)
        const candidates = tabs.filter(
          (t) =>
            (t.url && (t.url.includes(urlSubstring) || t.url.toLowerCase().includes(urlSubstring.toLowerCase()))) ||
            (t.pendingUrl && (t.pendingUrl.includes(urlSubstring) || t.pendingUrl.toLowerCase().includes(urlSubstring.toLowerCase())))
        );
        let lastFocusedWindowId = null;
        try {
          lastFocusedWindowId = (await chrome.windows.getLastFocused()).id;
        } catch (e) {}
        const picked = jffPickBestTab(candidates, lastFocusedWindowId);
        target = picked.tab;
        matchCount = picked.count;
      }

      if (!target) {
        sendBridgeResponse(requestId, {
          error: `No tab found matching ${tabId != null ? `tabId=${tabId}` : ""}${tabId != null && urlSubstring ? " and " : ""}${urlSubstring ? `urlSubstring="${urlSubstring}"` : ""}`
        });
        return;
      }

      const updatedTab = await chrome.tabs.update(target.id, { active: true });
      if (target.windowId) {
        try {
          await chrome.windows.update(target.windowId, { focused: true });
        } catch (e) {}
      }

      sendBridgeResponse(requestId, {
        success: true,
        data: {
          tabId: updatedTab?.id ?? target.id,
          windowId: updatedTab?.windowId ?? target.windowId,
          url: updatedTab?.url ?? target.url,
          title: updatedTab?.title ?? target.title,
          candidates: matchCount
        }
      });
    } else if (command === "GET_ACTIVE_FORM") {
      const results = await broadcastToAllFrames(activeTab, { action: "GET_JOB_AND_QUESTIONS", full: !!payload?.full });
      if (!results || results.length === 0) {
        sendBridgeResponse(requestId, { success: true, data: { questions: [], totalFieldsCount: 0 } });
      } else {
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
        sendBridgeResponse(requestId, { success: true, data: merged });
      }
    } else if (command === "AUTOFILL_STATIC") {
      const res = await chrome.storage.local.get(["candidateData", "activeProfileKey"]);
      const results = await broadcastToAllFrames(activeTab, {
        action: "AUTOFILL_STATIC",
        candidateData: res.candidateData,
        activeProfileKey: payload?.profileKey || res.activeProfileKey || null
      });
      const pick = (k) => results.flatMap((r) => r[k] || []);
      sendBridgeResponse(requestId, {
        success: true,
        data: {
          filledCount: results.reduce((acc, r) => acc + (r.filledCount || 0), 0),
          filled: pick("filled"),
          missingProfile: pick("missingProfile"),
          failed: pick("failed"),
          refilled: pick("refilled")
        }
      });
    } else if (command === "GET_PROFILE") {
      // Profile lives in the extension (edited in the popup); MCP reads it from here.
      const res = await chrome.storage.local.get(["candidateData", "activeProfileKey", "resumeFile"]);
      sendBridgeResponse(requestId, {
        success: true,
        data: {
          candidateData: res.candidateData || null,
          activeProfileKey: res.activeProfileKey || null,
          resumeFileName: res.resumeFile?.fileName || null
        }
      });
    } else if (command === "SET_PROFILE") {
      // AI agent (via MCP) fills the profile. mergeProfile whitelists editor paths and keeps
      // existing values unless overwrite, reporting them as conflicts for the agent to confirm.
      const res = await chrome.storage.local.get("candidateData");
      const { data, changed, conflicts, ignored } = mergeProfile(res.candidateData, payload?.patch, !!payload?.overwrite);
      if (changed.length) await chrome.storage.local.set({ candidateData: data });
      sendBridgeResponse(requestId, { success: true, data: { changed, conflicts, ignored } });
    } else if (command === "SCAN_FIELDS") {
      const results = await broadcastToAllFrames(activeTab, { action: "SCAN_FIELDS" });
      sendBridgeResponse(requestId, { success: true, data: results.flat() });
    } else if (command === "GET_FORM_STATE") {
      const results = await broadcastToAllFrames(activeTab, {
        action: "GET_FORM_STATE",
        maxValueLength: payload?.maxValueLength || 120,
        includeEmpty: payload?.includeEmpty !== false
      });
      sendBridgeResponse(requestId, { success: true, data: results.flatMap((r) => r.fields || []) });
    } else if (command === "CLICK_BUTTON") {
      const results = await broadcastToAllFrames(activeTab, {
        action: "CLICK_BUTTON",
        text: payload.text
      });
      const result = results.find((r) => r && r.success) || results.find((r) => r && r.denied) || results[0] || { success: false, reason: "No response from content script" };
      sendBridgeResponse(requestId, { success: true, data: result });

    } else if (command === "GET_SUBMISSION_STATUS") {
      const results = await broadcastToAllFrames(activeTab, { action: "GET_SUBMISSION_STATUS", tabUrl: activeTab.url || "" });
      const status = results.find((r) => r.isSubmitted) || results[0] || { isSubmitted: false };
      sendBridgeResponse(requestId, { success: true, data: status });
    } else if (command === "FILL_FORM") {
      const results = await broadcastToAllFrames(activeTab, {
        action: "INJECT_AI_ANSWERS",
        answers: payload.answers
      });
      const filled = results.flatMap((r) => r.filled || []);
      sendBridgeResponse(requestId, {
        success: true,
        data: {
          aiFilledCount: filled.length,
          failed: results.flatMap((r) => r.failed || []),
          // A key missing from every frame was never matched to a field.
          notFound: Object.keys(payload.answers || {}).filter(
            (ref) => !filled.includes(ref) && results.every((r) => (r.notFound || []).includes(ref))
          )
        }
      });
    } else {
      sendBridgeResponse(requestId, { error: `Unknown command: ${command}` });
    }
  } catch (err) {
    sendBridgeResponse(requestId, { error: err.message });
  }
}

// Send reply back to bridge
function sendBridgeResponse(requestId, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ requestId, response: data }));
  }
}

// Alarms to keep SW alive and reconnect if bridge drops (min chrome alarm = 0.5min in some versions, use 0.4)
chrome.alarms.create("checkBridgeAlarm", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkBridgeAlarm") {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
      connectBridge();
    }
  }
});

// Reconnect when tabs change or popup opens
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!isConnected) connectBridge();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "CHECK_BRIDGE") {
    connectBridge();
    sendResponse({ connected: isConnected });
  } else if (msg.action === "RETRY_BRIDGE") {
    connectBridge();
    sendResponse({ status: "Connecting..." });
  } else if (msg.action === "FETCH_RESUME_BLOB") {
    const profileKey = msg.profileKey || "";
    fetch(`http://127.0.0.1:8765/api/resume-pdf?profile=${encodeURIComponent(profileKey)}&format=base64`)
      .then((res) => res.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }
});

// Start bridge connection on worker start
connectBridge();
