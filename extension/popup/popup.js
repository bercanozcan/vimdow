// Vimdow popup — lists videos detected on the active tab and triggers
// downloads. Progressive MP4s download directly; HLS streams are fetched
// and merged by the offscreen document (progress shown on the button).

const content = document.getElementById("content");
const buttonsByVideo = new Map(); // videoId -> active download button

function formatDuration(seconds) {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return ` · ${m}:${String(s).padStart(2, "0")}`;
}

// Maps an actual resolution to the familiar quality name. Widescreen videos
// have unusual heights (1920x900 → "900p"), so classify by width against
// standard 16:9 tiers instead.
function qualityLabel(variant) {
  if (!variant.height) return "Best quality";
  const tiers = [
    [3840, "4K"],
    [2560, "1440p"],
    [1920, "1080p"],
    [1280, "720p"],
    [960, "540p"],
    [640, "360p"],
    [0, "240p"],
  ];
  if (variant.width) {
    for (const [minWidth, label] of tiers) {
      if (variant.width >= minWidth * 0.9) return label;
    }
  }
  return `${variant.height}p`;
}

function makeButton(label, onClick) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

function render(videos) {
  content.innerHTML = "";

  if (!videos || videos.length === 0) {
    content.innerHTML = "<p class='empty'>No Vimeo videos found on this page.</p>";
    return;
  }

  for (const video of videos) {
    const card = document.createElement("div");
    card.className = "video";

    if (video.thumbnail) {
      const img = document.createElement("img");
      img.src = video.thumbnail;
      card.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "info";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = video.title + formatDuration(video.duration);
    info.appendChild(title);

    const qualities = document.createElement("div");
    qualities.className = "qualities";

    // Direct progressive MP4s (rare on newer videos)
    for (const stream of video.progressive || []) {
      qualities.appendChild(
        makeButton(stream.quality, (btn) => {
          btn.disabled = true;
          btn.textContent = "…";
          chrome.runtime.sendMessage(
            {
              type: "VIMDOW_DOWNLOAD",
              url: stream.url,
              filename: `${video.title.replace(/[\\/:*?"<>|]+/g, "_")}-${stream.quality}.mp4`,
            },
            (res) => {
              btn.textContent = (res?.ok ? "✓ " : "✗ ") + stream.quality;
            }
          );
        })
      );
    }

    // HLS qualities (the common case)
    if ((video.progressive || []).length === 0 && video.hlsUrl) {
      const variants = video.variants?.length
        ? video.variants
        : [{ height: 0 }]; // unknown qualities — offer best available
      for (const variant of variants) {
        const label = qualityLabel(variant);
        const btnEl = makeButton(label, (btn) => {
            for (const b of qualities.querySelectorAll("button")) b.disabled = true;
            btn.textContent = "0%";
            buttonsByVideo.set(String(video.id), { btn, label });
            chrome.runtime.sendMessage(
              { type: "VIMDOW_DOWNLOAD_HLS", videoId: video.id, height: variant.height },
              (res) => {
                buttonsByVideo.delete(String(video.id));
                btn.textContent = (res?.ok ? "✓ " : "✗ ") + label;
                if (!res?.ok && res?.error) showError(info, res.error);
                for (const b of qualities.querySelectorAll("button")) b.disabled = false;
                btn.disabled = true;
              }
            );
        });
        if (variant.width) btnEl.title = `${variant.width}×${variant.height}`;
        qualities.appendChild(btnEl);
      }
    }

    if (qualities.children.length > 0) info.appendChild(qualities);

    if (video.error && qualities.children.length === 0) {
      showError(info, video.error);
    }

    card.appendChild(info);
    content.appendChild(card);
  }
}

function showError(parent, message) {
  const err = document.createElement("div");
  err.className = "error";
  err.textContent = `Error: ${message}`;
  parent.appendChild(err);
}

// Live download progress from the offscreen document
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "VIMDOW_PROGRESS") return;
  const entry = buttonsByVideo.get(String(msg.videoId));
  if (!entry) return;
  if (msg.stage === "segments") entry.btn.textContent = `${msg.pct}%`;
  else if (msg.stage === "merging") entry.btn.textContent = "Merging…";
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return render([]);
  chrome.runtime.sendMessage({ type: "VIMDOW_GET_VIDEOS", tabId: tab.id }, render);
}

init();
