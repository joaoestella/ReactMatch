# SyncVideo ⇄

A Chrome extension that **keeps a reaction or a live in sync with the game, movie or series you are watching**, even when each of you watches through a different service.

![SyncVideo panel](docs/images/panel-en.png)

You open the game in one tab and the creator's live in another. The creator shows the match clock on screen; your game also shows it. SyncVideo finds both clocks, reads them and moves your game (or pauses it) so both show the same minute. It keeps checking while you watch.

It doesn't matter if the creator watches on one service and you on another: what lines the videos up is **the moment in the content** (the match clock), not the position of each player. And because the clock is read from inside the creator's video, it arrives together with the reaction you hear.

## Features

- **Find clocks:** looks at a few frames of each video and keeps only the numbers that tick with the video. A score, a static "Replay 12:30" or a stream uptime in h:mm:ss are ignored. If there's more than one clock, you pick it with one click; you can always draw the box by hand.
- **Reads the players directly:** frames come straight from the `<video>` element, so there's no screen-sharing dialog. Players embedded from another site (iframes) work too, after you allow that site. DRM-protected players fall back to a tab capture.
- **Precise, and calm about it:** each frame carries the player position it was taken at, and several readings are averaged (the clocks only show whole seconds). A blurry frame is skipped; a jump (halftime, replay) stops the adjustments instead of chasing it.
- **Live players that can't rewind:** if the video that is ahead can't go back, it pauses for exactly the difference and resumes. Players that jump back to live on resume are detected and reported.
- **Same moment mode,** for videos without a clock: pause both on the same scene and mark it.
- **Fine adjustment** in half-second steps, and a **demo** with simulated clocks.
- English, Português and Español; follows Chrome's language, with a menu to change it.
- **Private:** no account, no server, no analytics. Frames are read in memory on your computer and discarded. [Privacy policy](https://joaoestella.github.io/SyncVideo/).

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension`** folder.
4. Pin the icon and click it: the SyncVideo panel opens in its own window.

Chrome 116+ (and Chromium browsers such as Edge, Brave and Opera).

## How to use

1. Open the two videos in tabs and press play on both.
2. In the panel, choose the creator's live as **A** and your game as **B** (B is the one that gets adjusted), and click **Connect** on each. Chrome asks for access to each site.
3. Click **Find clocks**, then **Start syncing**.

If one side can't rewind, swap the sides so the one you can control is B. For content without a clock, use **Same moment**: pause both at the same scene, click **Mark same moment** and start.

## Limits

- The panel window must stay open.
- One timeline per sync: halftime, replays, ads or a new episode need a new reference.
- Clocks are read as `mm:ss` or `h:mm:ss`. Stoppage time shown as `45:00 +2` is not understood yet.
- Players that block reading their image need the tab capture fallback, which Chrome asks you to confirm.
- TVs and apps outside the browser are not supported.

## Development

The extension is plain JavaScript (no build step) in `extension/`:

| File | What it does |
| --- | --- |
| `panel.js` | The session: connecting tabs, finding and reading clocks, keeping B in sync |
| `media-bridge.js` | Injected in each frame of a connected tab: lists, controls and grabs frames from `<video>` |
| `browser-adapter.js` | Talks to the bridge through `chrome.scripting` |
| `core.js` | Pure logic: clock parsing, tracking, offset estimation, what to correct and how |
| `finder.js` | Locates lines of text on a frame so OCR only reads small crops |
| `ocr.js` | Local Tesseract.js worker, frame crops, the box editor and the tab-capture fallback |
| `i18n.js`, `locales/` | Interface languages |

```sh
npm test               # unit tests (Node 20+)
npm install            # Playwright and Tesseract.js, for the tools below
npm run test:browser   # loads the extension in Chromium; needs ffmpeg with drawtext on PATH
npm run bundle:ocr     # rebuilds extension/vendor from node_modules
npm run preview        # serves the panel at http://127.0.0.1:4188 (demo only)
```

The browser tests build two videos with clocks burned in, then sync a creator live with a game embedded from another site, a live game with a 3-second rewind window, and a live player that jumps to live when resumed.

OCR: [Tesseract.js](https://github.com/naptha/tesseract.js) 7 with the `eng` model, bundled in `extension/vendor/` with their licenses. Nothing is downloaded at runtime.

See [ROADMAP.md](ROADMAP.md) for what's next.
