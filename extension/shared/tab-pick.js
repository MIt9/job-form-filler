// Chooses which tab a URL-substring match should focus. Pure function (also loaded by tests).
// Rules: ignore extension/internal pages (e.g. the chrome-extension://.../park.html tab an automation
// tool leaves behind), prefer the active tab of the last-focused window, then any active tab, then the
// most recently opened tab (highest id). Returns {tab, count} where count = usable candidates.
var jffPickBestTab = function (candidates, lastFocusedWindowId) {
  const usable = (candidates || []).filter((t) => t && !/^(chrome-extension|about|chrome|edge|devtools):/i.test(t.url || ""));
  if (!usable.length) return { tab: null, count: 0 };
  const tab =
    usable.find((t) => t.active && t.windowId === lastFocusedWindowId) ||
    usable.find((t) => t.active) ||
    usable.reduce((best, t) => (t.id > best.id ? t : best));
  return { tab, count: usable.length };
};
if (typeof module !== "undefined" && module.exports) module.exports = { jffPickBestTab };
