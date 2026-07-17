// Vimdow content script
// Runs in every frame. Detects Vimeo videos on the page and reports
// their IDs to the background service worker.

(() => {
  const found = new Set();
  let configSent = false;

  // Inside player.vimeo.com frames the page embeds window.playerConfig in an
  // inline <script>. Capturing it here works even for private/embed-restricted
  // videos, where a background fetch of the player page would fail.
  function extractPlayerConfig() {
    for (const script of document.scripts) {
      const text = script.textContent;
      const i = text.indexOf("window.playerConfig");
      if (i === -1) continue;
      const start = text.indexOf("{", i);
      if (start === -1) continue;
      let depth = 0, inStr = false, esc = false;
      for (let j = start; j < text.length; j++) {
        const c = text[j];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = inStr; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(text.slice(start, j + 1)); } catch { return null; }
          }
        }
      }
    }
    return null;
  }

  function detect() {
    const ids = [];

    // Case 1: we ARE the Vimeo player (this script runs inside iframes too)
    if (location.hostname === "player.vimeo.com") {
      const m = location.pathname.match(/\/video\/(\d+)/);
      if (m) {
        ids.push(m[1]);
        if (!configSent) {
          const config = extractPlayerConfig();
          if (config) {
            configSent = true;
            chrome.runtime.sendMessage({
              type: "VIMDOW_PLAYER_CONFIG",
              videoId: m[1],
              config,
            });
          }
        }
      }
    }

    // Case 2: a video page on vimeo.com (e.g. https://vimeo.com/123456789)
    if (/(^|\.)vimeo\.com$/.test(location.hostname) && location.hostname !== "player.vimeo.com") {
      const m = location.pathname.match(/^\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/)?(\d+)/);
      if (m) ids.push(m[1]);
    }

    // Case 3: embedded players on any site
    for (const iframe of document.querySelectorAll("iframe[src*='player.vimeo.com/video/']")) {
      const m = iframe.src.match(/player\.vimeo\.com\/video\/(\d+)/);
      if (m) ids.push(m[1]);
    }

    const fresh = ids.filter((id) => !found.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => found.add(id));

    chrome.runtime.sendMessage({
      type: "VIMDOW_VIDEOS_FOUND",
      videoIds: fresh,
      pageUrl: location.href,
    });
  }

  detect();

  // Vimeo pages and many sites load content dynamically — keep watching.
  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(detect, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
