# Seat idle motion recipe

Spec: VP9 webm, 360x540, 24fps, ~3s, no audio; `public/characters/<id>/portrait-motion.webm` (+ copy `idle-motion.webm`). Played by `PortraitStillOrMotion` (AgentCard.tsx) only when status is idle.

## 1. Generate (Grok Imagine via GenerateVideo, image-to-video, first = last frame for a seamless loop)
- image_path = last_frame_path = `public/characters/<id>/portrait.png` (853x1280, 2:3)
- duration 3, aspect_ratio 2:3 (output 480x720)
- prompt:
  > Subtle idle loop of this anime character: gentle breathing, one natural blink, slight hair and head sway. Character stays in place with the same pose, outfit, framing and background. Static camera, no zoom, no text, no new objects, anime style preserved.

## 2. Convert
```sh
D=public/characters/<id>
ffmpeg -i in.mp4 -an -vf "scale=360:540:flags=lanczos,fps=24" -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 $D/portrait-motion.webm
cp $D/portrait-motion.webm $D/idle-motion.webm
# preview
ffmpeg -i in.mp4 -an -vf "scale=360:540:flags=lanczos,fps=24" -c:v libx264 -pix_fmt yuv420p shots/<id>-idle-motion.mp4
```
Same 2:3 aspect as the still, so no crop/pad needed. Check frame 0 vs still (mean abs RGB diff ~2/255 for Marvis).

Marvis pilot (2026-10-26): attempt 1 accepted, 132240-byte webm.

## Batch 2026-10-26 — distinct action per character (all attempt 1, same settings/commands as above)
- autoclaw: "Anime character idle loop: she raises her free hand near her face and does a small playful cat-paw wave, curling her fingers like a claw, then lowers it back to the original pose. Body stays in place, same outfit, framing and white background. Static camera, no zoom, no text, no new objects, anime style preserved."
- claude-code: "...she tilts her head thoughtfully to one side, raises a finger to her chin as if pondering, gives a small nod, then returns to the original pose. ..."
- codebuddy: "...she cheerfully waves her raised hand side to side a couple of times with a bright smile, then settles back to the original pose. ..."
- codex: "...she glances down at the book she is holding, eyes reading for a moment, then looks back up at the viewer with a smile, returning to the original pose. Body stays in place, same outfit, book, framing and white background. Static camera, no zoom, no text changes, no new objects, anime style preserved."
- doubao: "...she gives a bright happy smile and a small bouncy shrug of her shoulders, twin tails bobbing, then settles back to the original pose. ..."
- dsh: "...with arms crossed, she calmly turns her eyes and head slightly to the side as if noticing something, then turns back to look at the viewer, returning to the original pose. ..."
- grok-bot: "...she does a confident small head tilt and a playful wink at the viewer with a smirk, then returns to the original pose. ..."
- hermes: "...her hair and draped blue cloth drift gently as if in a soft breeze, and she does one slow calm blink, then everything settles back to the original pose. Body stays still, ..."
("..." = same prefix "Anime character idle loop:" and same constraint suffix as autoclaw.)

## doubao — subtle v2 prompt (2026-10-26, replaces big version; attempt 1)
"Very subtle anime idle loop, minimal motion: she keeps a small warm smile, her shoulders rise only very slightly once and settle, twin tails barely sway, one soft blink. Body and head stay nearly perfectly still in place. Same outfit, framing and white background. Static camera, no zoom, no text, no new objects, anime style preserved."
Mean abs frame diff vs still (0-255): old 27.7 avg / 43.7 peak → v2 15.3 avg / 22.0 peak.
Tip for other chars: add "very subtle ... minimal motion ... nearly perfectly still" to halve amplitude.

## Subtle v2 batch (2026-10-26) — all 10 seats at doubao-v2 amplitude
Suffix for all: "Body and head stay nearly perfectly still in place. Same outfit, framing and white background. Static camera, no zoom, no text, no new objects, anime style preserved."
"v2b" = stronger wording: prefix "Extremely subtle anime idle loop, almost still image:" and "...stay perfectly still".
Mean/peak abs diff vs still (0-255), old → chosen:
- workbuddy (v2, try1): "Very subtle anime idle loop, minimal motion: her fingers resting on her cheek tap it once lightly and her cat ears give one tiny twitch, small gentle smile." 9.5/16.1 → 17.4/24.3 (try2 rejected: ear turned pink)
- marvis (v2b, try2): "Extremely subtle ... the faintest sway of her long hair and one soft blink." 11.9/20.3 → 8.2/12.1
- autoclaw (v2, try1): "Very subtle ... the hand near her face gives one tiny playful cat-paw flick of the fingers, then rests." 29.2/44.5 → 10.3/28.4
- claude-code (v2, try1): "Very subtle ... she tilts her head very slightly as if thinking and gives one tiny nod. ... hands stay where they are." 43.1/62.5 → 18.0/27.8 (try2 20.1/29.3, not better)
- codebuddy (v2, try1): "Very subtle ... the fingers of her raised hand give a tiny friendly wiggle, a micro wave, cheerful smile." 21.0/38.0 → 6.4/9.4
- codex (v2, try1): "Very subtle ... her eyes briefly glance down toward the book she holds, then back up to the viewer." 23.0/37.5 → 14.2/21.0
- doubao (v2): see above. 27.7/43.7 → 15.3/22.0
- dsh (v2b, try2): "Extremely subtle ... with arms crossed, only her eyes glance briefly to the side and back to the viewer." 27.2/42.1 → 15.8/26.7 (try1 22.3/32.5)
- grok-bot (v2b, try2): "Extremely subtle ... one quick wink with a tiny smirk, head tilts only a hair." 25.9/48.4 → 16.2/28.9 (try1 19.2/37.2)
- hermes (v2, try1): "Very subtle ... the ends of her hair and her blue drape drift faintly as if in a soft breeze, one slow blink." 18.7/29.0 → 18.2/24.4

## Stage transformation (WorkBuddy, 2026-10-26)

KF1 = `public/characters/workbuddy/stage.png` (white bg, 853x1280). KF2 = `wb-stage-kf2-E2.png` (polka-dot mint bikini, thick tail, sunset office desk; GenerateImage edit of E, 9:16 → crop 720x1080 from y=20 → 853x1280).

1. KF2 motion (GenerateVideo, image_path = last_frame_path = KF2, duration 4, 2:3, 720p) — historical prompt (do not regenerate; JL approved middle segment 2026-10-26):
   "Anime catgirl in a polka-dot mint bikini sitting on an office desk at sunset, static camera. The hand in her hair slowly slides down along her hair, she tilts her head slightly and winks at the viewer with a teasing smile. Her thick fluffy silver tail slowly sways left and right, tip curling. Cat ears twitch. She leans back slightly then returns, with natural soft body movement and a gentle bounce as she settles. A few sparkles drift in the air. Returns to the starting pose at the end. Clean anime style, consistent character."
2. `ffmpeg -i motion.mp4 -vf "fps=24,scale=853:1280:force_original_aspect_ratio=increase,crop=853:1280" mf/%04d.png` (reuse existing `mf/*.png`; do not re-extract unless regenerating motion).
3. Transitions in PIL (`docs/wb-stage-compose.py`): **mosaic (pixelate) dissolve only** — no light rings, particles, or white flash. 24 frames (~1s) each way: block size eases 1→~40px→1 via `sin(πt)` (downscale + nearest-neighbor upscale); short cross-dissolve under peak mosaic (t≈0.45–0.55) from KF1↔KF2; middle = unchanged `mf/*.png` motion; frame 0 and last frame forced to exact KF1 still for a seamless loop.
4. Encode (from `/workspace` after `python3 docs/wb-stage-compose.py` with cwd `/workspace` and script path `agent-status-board/docs/wb-stage-compose.py`, or `cd agent-status-board &&` adjust relative paths — compose expects cwd `/workspace`):
   - `ffmpeg -y -framerate 24 -i cf/%04d.png -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 -vf scale=534:800 -an shots/wb-stage-motion.webm`
   - preview (loop twice): `ffmpeg -y -stream_loop 1 -framerate 24 -i cf/%04d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -vf scale=852:1280 -an shots/wb-stage-motion-preview.mp4`
   - contact sheet written by compose: `shots/wb-stage-motion-frames.png`

5. **Wire into UI** (2026-10-26, JL approved mosaic single-loop):
   - Deploy as `public/characters/workbuddy/stage-motion.webm` (copy from `shots/wb-stage-motion.webm`).
   - `PortraitStillOrMotion` / `motionCandidateFor`: seat unchanged (`portrait.png` → `portrait-motion.webm`); **stage** now also resolves `stage.png` → `stage-motion.webm` when present (missing file → video onError → still). Offline skips motion.
   - Playback: one play per trigger (no `loop`), hide video on `ended` so the still underneath shows exact KF1 white-bg; random first delay 0.3–5s; then `randomIdleGapMs()` (1.2–5s) before next play — same rhythm as seats.
   - Other characters: no `stage-motion.webm` yet → stage stays static still.
