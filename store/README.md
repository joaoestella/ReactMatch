# Chrome Web Store: what to fill in

Everything the listing needs, ready to paste. Upload the zip built from the
`extension/` folder (see the end of this file).

## Images

| Field | File | Size |
| --- | --- | --- |
| Store icon | `icon-128.png` (also in the package) | 128×128, 96×96 artwork + transparent padding |
| Screenshots (English) | `screenshots/en/screenshot-1…5-*.png` | 1280×800, PNG without alpha |
| Screenshots (Portuguese) | `screenshots/pt/screenshot-1…5-*.png` | 1280×800, PNG without alpha |
| Screenshots (Spanish) | `screenshots/es/screenshot-1…5-*.png` | 1280×800, PNG without alpha |
| Small promo tile (required) | `promo/small-440x280.png` | 440×280 |
| Marquee promo tile (optional) | `promo/marquee-1400x560-en.png` / `-pt.png` / `-es.png` | 1400×560 |
| GitHub social preview | `github-social-preview-1280x640.png` | 1280×640 |

Order: 1 hero, 2 pick the tabs, 3 the cam, 4 one screen, 5 halftime and more.
Each set goes in its language's localization of the listing (English, Portuguese (Brazil), Spanish). How they were made: `scene/README.md`.

## Text

- **Name and summary** come from the package (`extension/_locales/<lang>/messages.json`):
  - en: *ReactMatch: Sync Reactions and Lives with Football*
  - pt_BR: *ReactMatch: React e Live no Tempo do Futebol*
  - es: *ReactMatch: Reacciones y Directos al Ritmo del Fútbol*
- **Description:** `listing/en.txt`, `listing/pt_BR.txt`, `listing/es.txt`.
- **Category:** Entertainment.
- **Language:** English (default), plus Portuguese (Brazil) and Spanish.

## Privacy tab

**Single purpose:** keep a reaction or live video in sync with the game or video the user watches in another tab, and optionally show the reaction's camera over that game.

**Permission justifications**

- `tabs`: list the user's open tabs so they can pick the game and the reaction, and briefly bring the reaction's tab to the front when it is in the background, so its on-screen clock can be read.
- `scripting`: inject the small script that reads and controls the `<video>` element (play, pause, seek, volume, a still frame to read the clock) in the two tabs the user picked.
- `tabCapture`: show the reaction's tab (picture and sound) over the game when the user turns the cam on, and keep a background reaction tab drawing after the user clicks the icon on it. The capture is shown only on the user's screen and never recorded or sent.
- `activeTab`: Chrome only allows capturing a tab after the user invokes the extension on it; clicking the icon (or Alt+Shift+S) on the reaction's tab grants that.
- `storage`: remember the interface language and the Simple/Pro choice.
- **Host permissions (optional, requested at runtime):** access only to the sites of the two tabs the user picks, requested when they pick them, to read and control the video players there.
- **Remote code:** No. Everything, including the text-recognition engine (Tesseract.js) and its language data, is bundled in the package.

**Data usage:** the extension collects none of the listed data types. Video frames are processed in memory on the device to read clocks and discarded; tab titles and addresses are only shown in the panel. Check the three certifications (no selling, no unrelated use, no creditworthiness).

**Privacy policy URL:** https://joaoestella.github.io/ReactMatch/

## Package

From the repository root:

```
cd extension && zip -r -X ../reactmatch-0.4.0.zip . -x '*.DS_Store'
```
