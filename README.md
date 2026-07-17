# Vimdow

> A browser extension that detects Vimeo videos on the page you're viewing and lets you download them for offline viewing.

🚧 **Status: Work in progress.** A working version lives in [`extension/`](extension/): it detects Vimeo videos (on vimeo.com and in embeds), shows title/thumbnail/qualities in the popup, and downloads both progressive MP4s and HLS streams — separate audio/video tracks are merged into a single MP4 in the browser, no re-encoding, no external tools.

## What It Will Do

- Detect a Vimeo video on the current page — whether you're on `vimeo.com` or the video is embedded in another site (`player.vimeo.com`)
- Show the available quality options
- Download the selected quality straight to your computer, no re-encoding, no third-party websites

## Why an Extension?

Vimeo doesn't expose direct MP4 links — video is delivered via adaptive streaming (HLS/DASH), so right-click → save doesn't work. An extension can read the player config on the page you already have open, list the available streams, and save the one you pick. Everything runs locally in your browser.

## How Vimeo Delivery Works (research notes)

1. **Player config** — Each video has a JSON config reachable through the player page (`https://player.vimeo.com/video/<id>`) that lists the available streams.
2. **HLS (`.m3u8`)** — A master playlist references per-quality playlists; segments must be fetched and remuxed into an MP4.
3. **DASH (`master.json`)** — Longer videos ship audio and video as separate streams that need merging after download.

The [`articles/`](articles/) folder contains hands-on research using `yt-dlp`, `streamlink`, and `ffmpeg`:

- [HLS via streamlink](articles/how-to-download-vimeo-videos-1.md)
- [`yt-dlp` against the m3u8 stream](articles/How%20to%20Download%20Vimeo%20Videos%20Method%202-%20%60yt-dlp%60%20at%20the%20m3u8%20stream.md)
- [Long videos / DASH streams](articles/Downloading%20Long%20Vimeo%20Videos%20(DASH%20Streams)%20with%20yt-dlp.md)
- [Password-protected videos](articles/Downloading%20Password-Protected%20Vimeo%20Videos%20with%20yt-dlp.md)

## Planned Architecture

- **Manifest V3** extension — Chrome/Edge/Brave first, Firefox later
- **Content script** — detects the Vimeo player on the page and extracts the video ID
- **Background service worker** — fetches the player config and stream manifests, starts downloads via the `downloads` API
- **Offscreen document** — remuxes HLS segments / merges DASH audio+video
- **Popup UI** — thumbnail preview, quality picker, download button with progress

### Planned Permissions

| Permission | Why |
| ---------- | --- |
| `downloads` | Save the file to disk |
| `activeTab` / `scripting` | Detect the player on the current page |
| `storage` | User preferences |
| `offscreen` | Merge/remux streams |
| Hosts: `*.vimeo.com`, `*.vimeocdn.com`, `*.akamaized.net` | Fetch configs, manifests and segments |

## Roadmap

- [x] Scaffold the MV3 extension (manifest, popup, content script, service worker)
- [x] Detect video IDs on `vimeo.com` pages and in embeds
- [x] Fetch player config and list available qualities
- [x] Download progressive MP4 when available (simplest path)
- [x] HLS support: fetch segments and merge audio+video into a single MP4 (pure-JS fMP4 muxer, no re-encoding)
- [ ] Stream large downloads to disk instead of buffering in memory
- [ ] DASH fallback for videos without HLS
- [ ] Firefox port

## Try It (development build)

1. Clone this repo (or download it as ZIP and extract)
2. Open `chrome://extensions/`, enable **Developer mode**
3. Click **Load unpacked** and select the [`extension/`](extension/) folder
4. Open any page with a Vimeo video and click the Vimdow icon

## Contributing

Issues and ideas are welcome — open one at [github.com/bercanozcan/vimdow/issues](https://github.com/bercanozcan/vimdow/issues).

## Legal Note

Vimdow is intended for downloading content you own or have explicit permission to save (your own uploads, licensed course material, client deliverables). Downloading videos may violate Vimeo's Terms of Service and the content owner's copyright — you are responsible for how you use this tool.
