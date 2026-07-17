// Vimdow offscreen document
// Downloads HLS playlists + media segments, merges the separate audio and
// video fMP4 tracks into a single MP4 (see lib/fmp4-merge.js), and hands a
// blob: URL back to the service worker to save via chrome.downloads.

"use strict";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "VIMDOW_OFFSCREEN_JOB") return;
  runJob(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // async response
});

function reportProgress(videoId, stage, pct) {
  chrome.runtime.sendMessage({ type: "VIMDOW_PROGRESS", videoId, stage, pct }).catch(() => {});
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url.slice(0, 80)}`);
  return res.text();
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url.slice(0, 80)}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseMediaPlaylist(text, baseUrl) {
  const mapMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const segments = text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => new URL(l.trim(), baseUrl).href);
  return {
    initUrl: mapMatch ? new URL(mapMatch[1], baseUrl).href : null,
    segmentUrls: segments,
  };
}

// Picks the variant whose height matches `height` (or the highest available).
function pickVariant(master, masterUrl, height) {
  const lines = master.split("\n");
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
    const bw = lines[i].match(/BANDWIDTH=(\d+)/);
    const uri = lines[i + 1]?.trim();
    if (!uri || uri.startsWith("#")) continue;
    variants.push({
      height: res ? parseInt(res[2]) : 0,
      bandwidth: bw ? parseInt(bw[1]) : 0,
      url: new URL(uri, masterUrl).href,
    });
  }
  if (variants.length === 0) throw new Error("no variants in master playlist");
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return variants.find((v) => v.height === height) || variants[0];
}

function pickAudio(master, masterUrl) {
  const m = master.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/);
  return m ? new URL(m[1], masterUrl).href : null;
}

// Downloads URLs with limited concurrency, preserving order.
async function fetchAll(urls, onProgress) {
  const results = new Array(urls.length);
  let next = 0, done = 0;
  const workers = Array.from({ length: 5 }, async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await fetchBytes(urls[i]);
      done++;
      onProgress(done, urls.length);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runJob({ videoId, hlsUrl, height }) {
  reportProgress(videoId, "playlist", 0);

  const master = await fetchText(hlsUrl);
  const variant = pickVariant(master, hlsUrl, height);
  const audioUrl = pickAudio(master, hlsUrl);

  const videoPl = parseMediaPlaylist(await fetchText(variant.url), variant.url);
  const audioPl = audioUrl
    ? parseMediaPlaylist(await fetchText(audioUrl), audioUrl)
    : null;

  const totalSegs = videoPl.segmentUrls.length + (audioPl ? audioPl.segmentUrls.length : 0);
  let fetched = 0;
  const onProgress = () => {
    fetched++;
    reportProgress(videoId, "segments", Math.round((fetched / totalSegs) * 100));
  };

  const videoInit = await fetchBytes(videoPl.initUrl);
  const videoSegs = await fetchAll(videoPl.segmentUrls, onProgress);

  let output;
  if (audioPl && audioPl.initUrl) {
    const audioInit = await fetchBytes(audioPl.initUrl);
    const audioSegs = await fetchAll(audioPl.segmentUrls, onProgress);
    reportProgress(videoId, "merging", 100);
    output = mergeFmp4(videoInit, videoSegs, audioInit, audioSegs);
  } else {
    // Muxed or video-only stream — plain concatenation is already valid fMP4
    output = new Uint8Array(
      [videoInit, ...videoSegs].reduce((n, a) => n + a.length, 0)
    );
    let off = 0;
    for (const part of [videoInit, ...videoSegs]) {
      output.set(part, off);
      off += part.length;
    }
  }

  const blob = new Blob([output], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(blob);
  reportProgress(videoId, "done", 100);
  return { ok: true, blobUrl, height: variant.height };
}
