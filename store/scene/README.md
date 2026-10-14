# Store images: how they are made

The screenshots show the real extension running on illustrated content made for
them: a fictional match (Leões x Tigres / Lions vs Tigers) and three fictional
hosts. No real broadcast, club, channel or person appears.

1. `node game.js > game.svg` and `node react.js > react.svg`, then render each to
   a 1280×720 PNG (any browser screenshot works).
2. Turn them into 150 s videos with a ticking clock burned in (ffmpeg `drawtext`):
   the game's scoreboard at 74:00 and the reaction's 20 s behind.
3. `xvfb-run node capture.cjs pt <dir>` (and `en`, `es`) loads the extension in
   Chromium, opens both "sites", picks the tabs, syncs, turns the cam on and
   saves the panel and the game.
4. `python3 compose.py` writes one HTML page per slide into `html/` (copy the
   captures and the 512 px icon as `icon.png` there), and `node render.cjs`
   renders them at 2×; downscale to 1280×800 without alpha.

Set `INTER_CSS` to a CSS file with an `@font-face` named `InterV` to use Inter,
the stand-in for Segoe UI on machines without it.
