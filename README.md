# AIC Stitcher

Stitches the **Arknights: Endfield** AIC (factory) top-down view into one large image. It runs entirely in the browser, so it can be hosted as a static site on GitHub Pages. No frames leave your device.

There are three ways in:

- **Live (desktop Chrome / Edge):** share the game window and pan around.
- **From a recording (any device, including phones):** screen-record yourself panning, then open the video. Mobile browsers can't share another app's screen (`getDisplayMedia` is desktop-only), so this is the way to use it on a phone.
- **From screenshots (any device):** take overlapping screenshots and open them together.

## Using it live

1. Run Endfield in windowed or borderless mode and open the AIC top-down view.
2. Click **Share game window** and pick the Endfield window.
3. Pan around with the zoom level fixed, and **stop for a moment every screen or so**. For the first ~24 moving frames the app learns which pixels are HUD, then the map starts filling in.
4. Click **Stop sharing**, then **Export PNG**.

Why stop: the game blurs moving frames and the video encoder smears them further, so a frame taken while the camera stands still is far sharper. Such frames are drawn at once and win over anything captured on the move. Whatever a frame shows that the map doesn't have yet is filled in immediately, from any frame.

A stop is one picture. Its frames replace each other for the first half second or so, while the picture settles; after that the stop is left alone however long you stay, so belts and machines are not redrawn in ever new states, and a menu opened later doesn't end up on the map.

The **confidence** button (bottom right of the map) tints what isn't well captured yet: red was only ever seen at the edge of the screen or next to the HUD, amber has not been seen from a still frame. Move the camera over those spots and pause; the tint goes away as they are replaced. The Status card shows both as percentages.

Belts, pipes and machines are animated, so each of them is kept as one sample from one frame instead of being averaged. While you share, a long belt still has a seam wherever two frames meet. That is put right when the sharing stops:

**When you stop sharing, the map is assembled from its still frames.** The game's camera has perspective, so raised things (belts, pipes, icons) sit a few pixels apart in two views of the same ground, more so the further apart the views were taken. Pieces from many moments and places, which is what a map has while it is being captured, therefore never quite fit. For the assembly every stop is laid in as one patch. Each spot goes to the stop whose camera was nearest, and the border between two stops is routed: it runs through ground both agree on and around belts, pipes and machines rather than through them. What no stop shows keeps what the capture put together, so stop often enough that the stops' middles cover the factory. Exporting while still sharing assembles first, too.

The Settings card shows only what you do to a map: **Rebuild from stills**, **Re-learn HUD** and **Clear map**. Everything that tunes how the map is built (crop margins, HUD detection, lighting, processing resolution) is under **Advanced settings**, closed by default; the defaults are meant to be right.

**Rebuild from stills** does that assembly on demand (nothing happens if nothing was captured since the last one). The Status card counts the still frames kept so far. Those of a screen share can't be read again and are held in memory, up to about 1 GB (some 70 stops at 1440p; less on devices with little memory); beyond that the most redundant ones are dropped.

If you need to open a menu, press **Pause**. Tracking keeps running, but nothing is drawn. Fast mouse drags or jumps are fine: if local tracking fails, the current view is matched against the whole map and tracking resumes wherever you are, provided that area is already on the map.

## Using a recording

Click **Open files** and pick the video (or drop it onto the map on desktop). The video stays paused and is seeked to every 1/15 s of footage; each frame is stitched before moving on. Slow devices therefore get the same result as fast ones, just more slowly, and it keeps working in a background tab. Recordings with frequent keyframes seek faster.

Frames are stitched at the recording's own resolution. If that is too slow, pick a lower **Processing resolution** under **Advanced settings** before you start (it applies to a new map).

The first few seconds are spent learning the HUD and aren't drawn. After the main pass, the app rewinds and stitches just that stretch again; the stitcher relocates itself on the map. This only adds anything when the recording never pans back over its starting area, but it's cheap (a few seconds of footage). **Pause** holds the video. Opening another recording afterwards extends the same map.

When the recording has been read to the end, the map is assembled from its still frames, as after a screen share. A recording can be read again, so only about 320 MB of still frames are kept in memory and the others are fetched from the video once more, by their time in it: every stop is used, however long the recording. **Assemble from still frames** under **Advanced settings** turns the assembly off for both.

This needs `VideoFrame` (WebCodecs): Chrome / Edge 94+, Safari 16.4+, Firefox 130+. It does not need `captureStream()`.

## Using screenshots

Click **Open files** and pick the screenshots (PNG or JPEG), or drop them onto the map. Their order doesn't matter.

- Keep the zoom level the same in all of them, and let each overlap its neighbours by a third or more. Every image is located by searching for where it fits among the others; one that overlaps nothing by at least a quarter is reported and left out.
- The HUD is found by comparing the screenshots: it is whatever stays in the same place on screen while the factory behind it differs. That takes at least two, and works better the more there are. Translucent HUD (the coloured glow in the corners of blueprint mode) can't be told apart this way; the crop margins are for that.
- Where the only screenshot of a spot has HUD over it, the spot is shown anyway and marked low confidence (red in the confidence view). Another screenshot with that spot nearer its middle replaces it.
- You can add screenshots one at a time, or to a map made from a recording. A map made only of screenshots is put together again from all of them each time.

The game's camera has perspective: raised things (pipes, floating icons) sit a few pixels apart in two screenshots of the same ground taken far apart. Each overlap is therefore joined along one seam instead of being mixed, and a facility or icon on the seam is taken whole from one screenshot. A pipe that runs exactly along a seam can still look pinched; more overlap between screenshots makes that rarer and smaller.

No game at hand? **Demo** pans over a real stitched AIC map ([src/assets/demo/](src/assets/demo/)) with a fake HUD and drifting cloud lighting on top, through the same pipeline.

## Development

```bash
npm install
npm run dev      # dev server
npm test         # unit + end-to-end synthetic stitching tests (Vitest)
npm run lint     # oxlint
npm run build    # typecheck + production build into dist/
```

Pushing to `main` deploys to GitHub Pages via [.github/workflows/deploy.yml](.github/workflows/deploy.yml). In the repository settings, set **Pages → Source** to **GitHub Actions**. `vite.config.ts` uses `base: './'`, so the build works under any `/<repo>/` path.

Stack: Vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui (Radix), lucide icons.

Dev helpers (skipped unless the env var is set):

```bash
BENCH=1 npx vitest run src/stitcher/bench.test.ts --silent=false      # per-stage timings at 1080p
DEBUG_OUT=/tmp/out npx vitest run src/stitcher/debug.test.ts --silent=false  # writes mosaic/ratio/quality PNGs
REPLAY=capture.mp4 REPLAY_WIDTH=1920 DEBUG_OUT=/tmp/out npx vitest run src/stitcher/replay.test.ts --silent=false  # replay a real recording (needs ffmpeg)
```

`DEBUG_OUT` gets `replay-mosaic.png` plus `replay-confidence.png` (red / amber / green), `replay-light.png` (the lighting layer) and `replay-mask.png` (the HUD mask). Decoding dominates a replay; `REPLAY_CACHE=dir` keeps the decoded frames (≈8 MB per 1080p frame) so repeated runs are several times faster. `REPLAY_WATCH=x,y,w,h` writes that world rectangle after every drawn frame, to see when a spot changes. `REPLAY_REBUILD=1` rebuilds the map from its still frames at the end, like the app does after a recording (`replay-before-rebuild.png` is the map before that, `replay-owner.png` shows which kind of view each pixel ended up from). `REPLAY_LIVE=1` replays like a screen share, where no frame can be read again; `REPLAY_HOLD=4` also stands at every stop for that many seconds, playing its frames back and forth (give it the log of a plain replay as `REPLAY_HOLD_AT` so the stops are lengthened in place).

Screenshots: `DEBUG_OUT=/tmp/out npx vitest run src/stitcher/stills.test.ts --silent=false` stitches `samples/*.png` if that folder exists (or `SAMPLES_DIR=...`) and writes `samples-stitched.png` and `samples-mask.png`.

Replay options: `REPLAY_PASS2=calib` re-runs the calibration frames afterwards, like the app does. `fwd` / `rev` re-run the whole recording forwards or backwards. `REPLAY_MAX_FRAMES=N` cuts the recording short. A second pass spills the decoded frames to a temp file (≈8 MB per 1080p frame, capped at 8 GB).

## How it works

![Pipeline: frame sources feed a web worker that prepares each frame, estimates coarse motion, aligns it to the map (relocalizing after jumps), learns the HUD, separates lighting from detail and composites into a tiled mosaic. The UI thread shows the map and live preview and exports the PNG.](docs/pipeline.svg)

The diagram is generated by [docs/pipeline.mjs](docs/pipeline.mjs). Edit it and run `npm run docs:diagram`.

All of the image processing lives in [src/stitcher/](src/stitcher/). It is plain TypeScript on typed arrays with no DOM dependencies, so it is unit-tested in Node.

| File | Purpose |
| --- | --- |
| `stitcher.ts` | Per-frame pipeline and tracking state machine (calibrating / tracking / lost). Decides how each frame is drawn: `full` while panning, `still` when the camera stands still (one picture per stop), `fill` when it only fills holes. Also stitches screenshots (`stitchImages`) and rebuilds the map from its still frames (`rebuildFromStills`, or `rebuildBegin` / `rebuildPatch` / `rebuildEnd` when frames have to be read again) |
| `phaseCorrelation.ts`, `fft.ts` | Coarse translation estimate. Local-mean removal and a band-pass filter make it ignore screen-fixed shading such as vignettes and cloud gradients |
| `refine.ts` | Full-resolution ZNCC search against the mosaic, scored per screen block so vignettes and cloud shadows don't hurt |
| `relocalize.ts` | Global search over the whole map (thumbnail ZNCC, then full-resolution verification) after fast moves or jumps |
| `uiMask.ts` | Learns the HUD mask from motion: pixels that stay put while the world scrolls. The mouse cursor is picked up the same way, and what it left on the map during a stop is taken back. For screenshots, where nothing moves, the HUD is voted on from pairs of images instead |
| `stills.ts` | Still frames (the stops of a capture, and screenshots): the store that keeps them within a memory budget (dropping only the pixels of frames that can be read again), and the planner that picks one frame per distinct stop |
| `mincut.ts` | Minimum cut on a grid, for routing the border between two still frames around belts, pipes and machines (`Mosaic.assemble`) |
| `mosaic.ts` | The map, in two layers. **Detail**: per pixel the best single sample, with its quality and how often it was confirmed. **Lighting**: a low-resolution average of every frame's brightness, with the game's vignette modelled and removed. The picture is detail re-lit with the shared lighting, so cloud shadows and the vignette leave no patches. Also the confidence grid and gap inpainting for export |
| `worker.ts`, `protocol.ts`, `client.ts` | Worker plumbing |
| `capture.ts` | Screen, video-file and demo sources |
| `synthetic.ts` | Fake HUD, lighting and pan path for the Demo; procedural test world for the tests |
