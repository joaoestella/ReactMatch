# Roadmap

SyncVideo keeps a second video (a reaction, a live, a commentary) in sync with
the content it refers to. The product is not tied to one sport or community;
football with a creator's live is simply the first case to validate.

## Done (0.2)

- Clocks read straight from the players, including players embedded from other sites.
- Automatic clock detection, with one-click choice when there are several.
- Offset averaged over several readings; jumps stop the adjustments.
- Live players that can't rewind are delayed by pausing; players that jump to live are detected.
- English, Portuguese and Spanish.

## Next: validate with real streams

Pick a few real combinations (a creator live on YouTube or Twitch plus the
service viewers use for the game) and measure: time to sync after opening the
panel, interventions per half, and whether people use it again next match.
Check stylized scoreboard fonts, low resolutions and Windows display scaling.

## Clocks

- Stoppage time (`45:00 +2`, `90+3'`) and periods (1st/2nd half, quarters).
- Clocks that stop (basketball, American football): keep the last good offset
  while the clock is stopped instead of waiting.
- Find the clock again when the scoreboard moves or disappears (replays).

## Without a clock

For movies and series there is no clock on screen. Options to study: match a
few seconds of audio between the two videos (audio fingerprinting), or let the
creator publish markers.

## Creator tools

A "Sync with me" link and an optional overlay for OBS: a small marker inside
the creator's stream carrying the moment they are watching. It travels inside
the video, so it arrives with the reaction, and it's built for machine reading,
so it is more reliable than any scoreboard font. Each viewer still has their
own delay; one delay set by the creator would not fit everyone.

## Store

Publish on the Chrome Web Store once the permissions, privacy policy and the
supported combinations are validated.
