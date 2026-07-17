// Vimdow background service worker
// Collects detected video IDs per tab, resolves video info (title, streams,
// qualities), and coordinates downloads. HLS downloads are delegated to the
// offscreen document, which fetches segments and merges them into one MP4.
//
// NOTE: Vimeo's /config endpoint returns 403 for requests made outside a
// player page context, so video info is extracted from the player page HTML
// (window.playerConfig) instead — either fetched here, or captured directly
// by the content script running inside the player iframe.

// ---- Per-tab video registry (survives service worker restarts) ----

async function getTabVideos(tabId) {
  const key = `tab-${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

async function addTabVideos(tabId, videoIds) {
  const key = `tab-${tabId}`;
  const existing = await getTabVideos(tabId);
  const merged = [...new Set([...existing, ...videoIds])];
  await chrome.storage.session.set({ [key]: merged });
}

async function getStoredInfo(videoId) {
  const key = `info-${videoId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function storeInfo(videoId, info) {
  await chrome.storage.session.set({ [`info-${videoId}`]: info });
}

// ---- Message routing ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return; // handled by the offscreen document

  if (msg.type === "VIMDOW_VIDEOS_FOUND" && sender.tab) {
    addTabVideos(sender.tab.id, msg.videoIds);
    return;
  }

  if (msg.type === "VIMDOW_PLAYER_CONFIG" && msg.videoId) {
    // Config captured by the content script inside the player iframe —
    // authoritative, works for private/embed-restricted videos too.
    infoFromConfig(msg.videoId, msg.config)
      .then((info) => storeInfo(msg.videoId, info))
      .catch(() => {});
    return;
  }

  if (msg.type === "VIMDOW_GET_VIDEOS") {
    getTabVideos(msg.tabId)
      .then((ids) => Promise.all(ids.map(resolveVideo)))
      .then(sendResponse);
    return true; // async response
  }

  if (msg.type === "VIMDOW_DOWNLOAD") {
    chrome.downloads
      .download({ url: msg.url, filename: msg.filename })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "VIMDOW_DOWNLOAD_HLS") {
    handleHlsDownload(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab-${tabId}`);
});

// ---- Player config extraction ----

// Extracts the JSON object that follows `marker` in `text` using
// balanced-brace scanning (the object is too irregular for a simple regex).
function extractJsonAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i === -1) return null;
  const start = text.indexOf("{", i);
  if (start === -1) return null;
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
  return null;
}

async function fetchPlayerConfig(videoId) {
  const res = await fetch(`https://player.vimeo.com/video/${videoId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`player page failed (${res.status})`);
  const config = extractJsonAfter(await res.text(), "window.playerConfig");
  if (!config) throw new Error("playerConfig not found in player page");
  return config;
}

async function infoFromConfig(videoId, config) {
  const files = config.request?.files || {};
  const hls = files.hls;
  const thumbs = config.video?.thumbs || {};

  const info = {
    id: String(videoId),
    title: config.video?.title || `Vimeo video ${videoId}`,
    thumbnail: thumbs["640"] || thumbs.base || null,
    duration: config.video?.duration || null,
    progressive: (files.progressive || [])
      .map((f) => ({ quality: f.quality, url: f.url }))
      .sort((a, b) => parseInt(b.quality) - parseInt(a.quality)),
    hlsUrl: hls?.cdns?.[hls.default_cdn]?.avc_url || hls?.cdns?.[hls.default_cdn]?.url || null,
    variants: null, // [{height, bandwidth}]
    error: null,
  };

  if (info.hlsUrl) {
    try {
      info.variants = await fetchHlsVariants(info.hlsUrl);
    } catch {
      // variants stay null; popup will show a generic download option
    }
  }
  return info;
}

async function fetchHlsVariants(hlsUrl) {
  const res = await fetch(hlsUrl);
  if (!res.ok) throw new Error(`master playlist failed (${res.status})`);
  const lines = (await res.text()).split("\n");
  const byHeight = new Map();
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
    const bandwidth = line.match(/BANDWIDTH=(\d+)/);
    if (!resolution) continue;
    const width = parseInt(resolution[1]);
    const height = parseInt(resolution[2]);
    const bw = bandwidth ? parseInt(bandwidth[1]) : 0;
    if (!byHeight.has(height) || byHeight.get(height).bandwidth < bw) {
      byHeight.set(height, { width, height, bandwidth: bw });
    }
  }
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

async function resolveVideo(videoId) {
  let info = await getStoredInfo(videoId);

  if (!info || (!info.progressive?.length && !info.hlsUrl)) {
    try {
      info = await infoFromConfig(videoId, await fetchPlayerConfig(videoId));
    } catch (err) {
      info = info || {
        id: String(videoId),
        title: `Vimeo video ${videoId}`,
        thumbnail: null,
        progressive: [],
        hlsUrl: null,
        variants: null,
        error: String(err.message || err),
      };
    }
  }

  // Variants may be missing when info came from the content script capture
  if (info.hlsUrl && !info.variants) {
    try {
      info.variants = await fetchHlsVariants(info.hlsUrl);
    } catch {}
  }

  await storeInfo(videoId, info);
  return info;
}

// ---- HLS download via offscreen document ----

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Fetch HLS media segments and merge them into an MP4 file for download",
  });
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120).trim() || "vimeo-video";
}

async function handleHlsDownload({ videoId, height }) {
  await ensureOffscreen();

  // Signed stream URLs expire — re-resolve fresh right before downloading.
  let info;
  try {
    info = await infoFromConfig(videoId, await fetchPlayerConfig(videoId));
  } catch {
    info = await getStoredInfo(videoId);
  }
  if (!info?.hlsUrl) return { ok: false, error: "No HLS stream available" };

  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "VIMDOW_OFFSCREEN_JOB",
    videoId,
    hlsUrl: info.hlsUrl,
    height,
  });
  if (!result?.ok) return result || { ok: false, error: "offscreen job failed" };

  const filename = `${sanitizeFilename(info.title)}-${result.height}p.mp4`;
  const downloadId = await chrome.downloads.download({ url: result.blobUrl, filename });
  return { ok: true, downloadId };
}
