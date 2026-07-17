# Vimdow Privacy Policy

_Last updated: 2026-07-17_

Vimdow is a browser extension that detects Vimeo videos on the page you are viewing and lets you download them to your computer.

## Data Collection

**Vimdow does not collect, store, transmit, or sell any personal data.**

- No analytics, no telemetry, no tracking of any kind
- No account, sign-up, or license required
- No data is sent to the developer or any third party

## What the Extension Accesses and Why

- **Pages you visit (content script):** used only to detect whether a Vimeo player is present on the page and read its video ID. Nothing about your browsing is recorded or transmitted.
- **vimeo.com / vimeocdn.com / akamaized.net requests:** used only to fetch video metadata (title, thumbnail, available qualities) and the video streams you explicitly choose to download.
- **Downloads permission:** used only to save the video file you requested to your computer.
- **Storage permission:** stores a temporary, session-only list of videos detected per tab. It is kept locally in your browser and cleared automatically.
- **Offscreen permission:** used to merge downloaded audio/video streams into a single MP4 file locally in your browser.

All processing happens locally in your browser. No external servers are involved other than Vimeo's own content delivery network.

## Contact

Questions or concerns: open an issue at https://github.com/bercanozcan/vimdow/issues
