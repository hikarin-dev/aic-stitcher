/**
 * Dev helper: replays a screen recording through the stitcher (needs ffmpeg on PATH).
 *   REPLAY=path/to/video.webm [REPLAY_FPS=15] [REPLAY_WIDTH=1920] [DEBUG_OUT=dir] [REPLAY_PASS2=fwd|rev|calib] \
 *     [REPLAY_CACHE=dir] [REPLAY_REBUILD=1] [REPLAY_LIVE=1] [REPLAY_HOLD=seconds [REPLAY_HOLD_AT=log]] \
 *     npx vitest run src/stitcher/replay.test.ts --silent=false
 * Logs every frame's tracking result and, with DEBUG_OUT, writes the final map plus
 * debug views (HUD mask, lighting layer, confidence).
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { it } from 'vitest'
import { DEFAULT_SETTINGS, Stitcher, type FrameStatus } from './stitcher'
import { writeConfidencePng, writeLightPng, writeMosaicPng, writePng, writeRegionPng } from './testing/png'

const SRC = process.env.REPLAY
const FPS = Number(process.env.REPLAY_FPS ?? 15)
const WIDTH = Number(process.env.REPLAY_WIDTH ?? 1920)
const OUT = process.env.DEBUG_OUT
const DUMP = new Set((process.env.REPLAY_DUMP ?? '').split(',').filter(Boolean).map(Number))
/**
 * Optional second pass over the same frames: 'fwd' (from the start again), 'rev' (backwards
 * from the end) or 'calib' (only the frames that were spent on calibration, forwards).
 */
const PASS2 = process.env.REPLAY_PASS2 as 'fwd' | 'rev' | 'calib' | undefined
/** Stop after this many frames (simulates a shorter recording). */
const MAX_FRAMES = Number(process.env.REPLAY_MAX_FRAMES ?? Infinity)
/**
 * Directory for decoded frames (raw RGBA, ≈8 MB per 1080p frame). Decoding and scaling
 * dominate a replay, so repeated runs over the same recording get several times faster.
 */
const CACHE = process.env.REPLAY_CACHE
// REPLAY_REBUILD=1: rebuild the map from its still frames at the end (Stitcher.rebuildFromStills).
/** Write the map every N frames as well (to see how it builds up). */
const SNAPSHOT_EVERY = Number(process.env.REPLAY_SNAPSHOTS ?? 0)
/**
 * "x,y,w,h[,from[,to]]": write this world rectangle of the map after every frame that
 * was drawn (optionally only for frames from..to), plus the frame's own view of it.
 */
const WATCH = process.env.REPLAY_WATCH?.split(',').map(Number)
/** "x,y": log the stored quality / confirmations / luma of this world pixel after every frame. */
const PROBE = process.env.REPLAY_PROBE?.split(',').map(Number)
/**
 * Seconds to stand at every stop of the recording, like someone sharing their screen
 * does (recordings are usually panned through without pausing). The frames of the stop
 * are played back and forth for that long, so whatever is animated keeps moving.
 *
 * Where the stops are is only known afterwards. With REPLAY_HOLD_AT (the log of an
 * earlier replay of the same recording at the same size and rate) every stop is simply
 * made longer. Without it, the camera has already moved on when a stop is recognised:
 * it then steps back and stands there, which to the stitcher is a second stop.
 */
const HOLD = Number(process.env.REPLAY_HOLD ?? 0)
const HOLD_AT = process.env.REPLAY_HOLD_AT
/** Like screen sharing: no frame can be read again later. (Implied by REPLAY_HOLD.) */
const LIVE = !!process.env.REPLAY_LIVE || HOLD > 0

async function probeSize(src: string): Promise<[number, number]> {
  const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src])
  let out = ''
  probe.stdout.on('data', (d) => (out += d))
  await new Promise((r) => probe.on('close', r))
  const [w, h] = out.trim().split(',').map(Number)
  return [w, h]
}

/** Yields decoded frames (the buffer is reused between frames). */
async function* frames(src: string, w: number, h: number): AsyncGenerator<Uint8Array> {
  const frameBytes = w * h * 4
  const cachePath = CACHE ? join(CACHE, `${basename(src)}.${w}x${h}.${FPS}fps.rgba`) : null
  if (cachePath && existsSync(cachePath)) {
    const fd = openSync(cachePath, 'r')
    const count = Math.floor(statSync(cachePath).size / frameBytes)
    const one = Buffer.alloc(frameBytes)
    try {
      for (let i = 0; i < count; i++) {
        readSync(fd, one, 0, frameBytes, i * frameBytes)
        yield one
      }
    } finally {
      closeSync(fd)
    }
    return
  }
  let cacheFd = -1
  if (cachePath) {
    mkdirSync(CACHE!, { recursive: true })
    cacheFd = openSync(`${cachePath}.part`, 'w')
  }
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', src, '-vf', `fps=${FPS},scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
  let pending: Buffer[] = []
  let size = 0
  let complete = false
  try {
    for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
      pending.push(chunk)
      size += chunk.length
      if (size < frameBytes) continue
      let buf = pending.length === 1 ? pending[0] : Buffer.concat(pending)
      while (buf.length >= frameBytes) {
        const frame = buf.subarray(0, frameBytes)
        if (cacheFd >= 0) writeSync(cacheFd, frame, 0, frameBytes)
        yield frame
        buf = buf.subarray(frameBytes)
      }
      pending = buf.length ? [buf] : []
      size = buf.length
    }
    complete = true
  } finally {
    ff.kill()
    if (cacheFd >= 0) {
      closeSync(cacheFd)
      // Only a fully decoded recording is a valid cache.
      if (complete) renameSync(`${cachePath}.part`, cachePath!)
      else rmSync(`${cachePath}.part`, { force: true })
    }
  }
}

it.runIf(!!SRC)(
  'replay recording',
  async () => {
    const [sw, sh] = await probeSize(SRC!)
    const w = Math.min(WIDTH, sw)
    const h = Math.round((sh * w) / sw / 2) * 2
    console.log(`source ${sw}x${sh} -> ${w}x${h} @ ${FPS} fps`)

    const frameBytes = w * h * 4
    const stitcher = new Stitcher({ ...DEFAULT_SETTINGS, crop: { top: 0.1, bottom: 0.1, left: 0.02, right: 0.02 } })
    // REPLAY_KEYFRAME_MB: memory budget for still frames (default: the app's).
    if (process.env.REPLAY_KEYFRAME_MB) stitcher.setKeyframeBudget(Number(process.env.REPLAY_KEYFRAME_MB) * 1024 * 1024)
    if (process.env.REPLAY_FIXED_VIGNETTE) stitcher.mosaic.learnVignette = false
    let index = 0
    let lost = 0
    let drawn = 0
    let total = 0
    const timing: Record<string, number> = {}
    // Brightness drift check: mean luma of the raw frames' centres vs. the final map.
    let frameLumSum = 0
    let frameLumN = 0
    // Pass 2 re-reads the decoded frames from a raw spill file.
    const spillPath = join(tmpdir(), `aic-replay-${process.pid}.raw`)
    const spill = PASS2 ? openSync(spillPath, 'w+') : -1
    let spilled = 0
    let spilling = spill >= 0 // only while decoding pass 1
    let calibEnd = -1 // first frame that was no longer spent on calibration
    const coverage = () => {
      let n = 0
      for (const t of stitcher.mosaic.tiles.values()) for (let i = 0; i < t.q.length; i++) if (t.q[i]) n++
      return n
    }
    const writeMaskPng = (path: string) => {
      const m = stitcher.getUiMask()!
      const img = new Uint8ClampedArray(m.width * m.height * 4)
      for (let i = 0; i < m.mask.length; i++) {
        img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = m.mask[i] ? 255 : 0
        img[i * 4 + 3] = 255
      }
      writePng(path, img, m.width, m.height)
    }
    /** Frames at or beyond this number are a second pass: their number is not their place in the cache. */
    let pass1Limit = Infinity
    const handle = (frame: Uint8Array): FrameStatus => {
      if (spilling) {
        if ((spilled + 1) * frameBytes > 8 * 1024 ** 3) {
          closeSync(spill)
          rmSync(spillPath, { force: true })
          throw new Error('Replay spill file would exceed 8 GB; use a lower REPLAY_WIDTH or REPLAY_FPS.')
        }
        writeSync(spill, frame, 0, frameBytes)
        spilled++
      }
      const rgba = new Uint8ClampedArray(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frameBytes))
      for (let y = Math.floor(h * 0.25); y < h * 0.75; y += 8) {
        for (let x = Math.floor(w * 0.25); x < w * 0.75; x += 8) {
          const o = (y * w + x) * 4
          frameLumSum += (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8
          frameLumN++
        }
      }
      // With a frame cache, any frame can be read again by its number, like a recording in the app.
      const st = stitcher.process({
        rgba,
        width: w,
        height: h,
        timestamp: (index * 1000) / FPS,
        refetchKey: CACHE && !LIVE && index < pass1Limit ? index : undefined,
      })
      total += st.processMs
      for (const [k, v] of Object.entries(st.timings)) timing[k] = (timing[k] ?? 0) + v
      if (st.state === 'lost') lost++
      if (st.composited) drawn++
      if (calibEnd < 0 && st.state !== 'calibrating') calibEnd = index
      console.log(
        `${String(index).padStart(4)} ${st.state.padEnd(11)} pos=${st.x},${st.y} v=${st.speed.toFixed(0)} match=${st.matchScore?.toFixed(3) ?? '-'} ${st.drawMode ?? ''} ${st.processMs.toFixed(0)}ms`,
      )
      if (PROBE) {
        const t = stitcher.mosaic.getTile(PROBE[0] >> 9, PROBE[1] >> 9)
        const i = (PROBE[1] & 511) * 512 + (PROBE[0] & 511)
        if (t) console.log(`     probe q=${t.q[i]} n=${t.n[i]} lum=${t.lum[i]}`)
      }
      if (OUT && DUMP.has(index)) {
        writePng(`${OUT}/replay-frame-${index}.png`, rgba, w, h)
        writeMaskPng(`${OUT}/replay-mask-${index}.png`)
      }
      if (OUT && WATCH && !process.env.REPLAY_REBUILD && st.composited && index >= (WATCH[4] ?? 0) && index <= (WATCH[5] ?? Infinity)) {
        const [wx, wy, ww, wh] = WATCH
        if (st.x < wx + ww && st.y < wy + wh && st.x + w > wx && st.y + h > wy) {
          const tag = String(index).padStart(4, '0')
          writeRegionPng(`${OUT}/watch-${tag}-map.png`, stitcher.mosaic, wx, wy, ww, wh)
          const view = new Uint8ClampedArray(ww * wh * 4)
          for (let y = 0; y < wh; y++) {
            const fy = wy + y - st.y
            if (fy < 0 || fy >= h) continue
            for (let x = 0; x < ww; x++) {
              const fx = wx + x - st.x
              if (fx < 0 || fx >= w) continue
              view.set(rgba.subarray((fy * w + fx) * 4, (fy * w + fx) * 4 + 4), (y * ww + x) * 4)
            }
          }
          writePng(`${OUT}/watch-${tag}-frame-${st.drawMode}.png`, view, ww, wh)
        }
      }
      index++
      if (OUT && SNAPSHOT_EVERY > 0 && index % SNAPSHOT_EVERY === 0) writeMosaicPng(`${OUT}/replay-snap-${index}.png`, stitcher.mosaic)
      return st
    }
    // REPLAY_HOLD: the frames of the stop the camera is at (copies; the last few).
    let stop: Uint8Array[] = []
    let last: { x: number; y: number; frame: Uint8Array } | null = null
    let held = 0
    /** Plays the frames of the stop back and forth, starting at `from` going backwards. */
    const hold = (from: number) => {
      let j = Math.max(0, from)
      let dir = -1
      for (let k = Math.round(HOLD * FPS); k > 0; k--) {
        handle(stop[j])
        if (j + dir < 0 || j + dir >= stop.length) dir = -dir
        if (j + dir >= 0 && j + dir < stop.length) j += dir
      }
      held++
    }
    // REPLAY_HOLD_AT: source frame number -> how many frames the stop ending there has.
    const stopEnds = new Map<number, number>()
    if (HOLD > 0 && HOLD_AT) {
      const pos: string[] = []
      for (const line of readFileSync(HOLD_AT, 'utf8').split('\n')) {
        const m = /^\s*(\d+) tracking\s+pos=(-?\d+,-?\d+)/.exec(line)
        if (m) pos[Number(m[1])] = m[2]
      }
      let run = 1
      for (let i = 1; i <= pos.length; i++) {
        if (i < pos.length && pos[i] !== undefined && pos[i] === pos[i - 1]) run++
        else {
          if (run >= 2) stopEnds.set(i - 1, run)
          run = 1
        }
      }
    }
    let source = 0
    for await (const frame of frames(SRC!, w, h)) {
      if (index >= MAX_FRAMES) break
      const st = handle(frame)
      const at = source++
      if (HOLD <= 0) continue
      if (HOLD_AT) {
        stop.push(frame.slice())
        if (stop.length > 8) stop.shift()
        const run = stopEnds.get(at)
        // (Not where the camera only paused for a frame: that one frame is soft from
        // the move, and standing there for real would not give more of the same.)
        if (run !== undefined && run >= 3) {
          // The last frames of the stop: its first ones are still soft, too.
          stop = stop.slice(-Math.min(run - 1, 3, stop.length))
          hold(stop.length - 2)
        }
        continue
      }
      if (st.state === 'tracking' && last && st.x === last.x && st.y === last.y) {
        if (stop.length === 0) stop.push(last.frame)
        stop.push(frame.slice())
        if (stop.length > 8) stop.shift()
      } else {
        if (stop.length >= 2) {
          // The stop is over. Go back and stand there for a while, then move on from
          // here again: to the stitcher, a small step away and back.
          hold(stop.length - 1)
          handle(frame)
        }
        stop = []
      }
      last = { x: st.x, y: st.y, frame: frame.slice() }
    }
    if (HOLD > 0) console.log(`held ${HOLD} s at ${held} stops`)
    const pass1Frames = index
    pass1Limit = pass1Frames
    console.log(`pass1: frames=${pass1Frames} coverage=${coverage()}`)
    spilling = false
    if (spill >= 0) {
      const one = Buffer.alloc(frameBytes)
      const count = PASS2 === 'calib' ? Math.max(0, calibEnd) : spilled
      for (let k = 0; k < count; k++) {
        const j = PASS2 === 'rev' ? spilled - 1 - k : k
        readSync(spill, one, 0, frameBytes, j * frameBytes)
        handle(one)
      }
      closeSync(spill)
      rmSync(spillPath, { force: true })
      console.log(`pass2 (${PASS2}): frames=${index - pass1Frames} coverage=${coverage()}`)
    }
    console.log(
      `frames=${index} lost=${lost} drawn=${drawn} avgMs=${(total / index).toFixed(1)}`,
      Object.entries(timing).map(([k, v]) => `${k}=${(v / index).toFixed(1)}`).join(' '),
    )
    if (process.env.REPLAY_REBUILD) {
      // Like the app does after a recording: assemble the map from the still frames.
      if (OUT) writeMosaicPng(`${OUT}/replay-before-rebuild.png`, stitcher.mosaic)
      const t0 = performance.now()
      // Which pixels no still took over: 127 = captured mid-screen, 4 = at a screen edge.
      const debug = {
        beforeFinish: () => {
          if (!OUT) return
          const b = stitcher.mosaic.exactBounds()!
          const w = b.maxX - b.minX
          const h = b.maxY - b.minY
          const img = new Uint8ClampedArray(w * h * 4)
          for (const t of stitcher.mosaic.tiles.values()) {
            for (let y = 0; y < 512; y++) {
              const wy = t.ty * 512 + y - b.minY
              if (wy < 0 || wy >= h) continue
              for (let x = 0; x < 512; x++) {
                const wx = t.tx * 512 + x - b.minX
                const i = y * 512 + x
                if (wx < 0 || wx >= w || t.q[i] === 0) continue
                const o = (wy * w + wx) * 4
                const n = t.n[i]
                img[o] = n === 127 ? 255 : n === 4 ? 60 : n >= 128 ? 30 : 110
                img[o + 1] = n === 127 ? 60 : n === 4 ? 90 : n >= 128 ? 30 + ((n - 128) * 1.5) : 110
                img[o + 2] = n === 127 ? 60 : n === 4 ? 255 : n >= 128 ? 30 : 30
                img[o + 3] = 255
              }
            }
          }
          writePng(`${OUT}/replay-owner.png`, img, w, h)
        },
      }
      // Like the app after a recording: stills whose pixels were dropped are read again.
      const cachePath = CACHE ? join(CACHE, `${basename(SRC!)}.${w}x${h}.${FPS}fps.rgba`) : null
      let r: ReturnType<typeof stitcher.rebuildEnd> | null = null
      let fetched = 0
      const plan = stitcher.rebuildBegin(!LIVE && !!cachePath && existsSync(cachePath))
      if (plan) {
        const fd = plan.patches.some((p) => !p.inMemory) ? openSync(cachePath!, 'r') : -1
        const one = Buffer.alloc(frameBytes)
        plan.patches.forEach((p, i) => {
          if (p.inMemory) stitcher.rebuildPatch(i)
          else {
            readSync(fd, one, 0, frameBytes, p.key! * frameBytes)
            const rgba = new Uint8ClampedArray(one.buffer.slice(one.byteOffset, one.byteOffset + frameBytes))
            stitcher.rebuildPatch(i, { rgba, width: w, height: h })
            fetched++
          }
          console.log(`  patch ${i}: still at ${p.x},${p.y}${p.inMemory ? '' : ' (read again)'}${p.suspects ? `, ${p.suspects} places to check` : ''}`)
          // With REPLAY_WATCH: the watched rectangle after every patch.
          if (OUT && WATCH) writeRegionPng(`${OUT}/rebuild-${String(i).padStart(2, '0')}.png`, stitcher.mosaic, WATCH[0], WATCH[1], WATCH[2], WATCH[3])
        })
        if (fd >= 0) closeSync(fd)
        r = stitcher.rebuildEnd(debug)
      }
      console.log(`rebuild: ${plan ? plan.patches.length : 0} patches planned, ${fetched} read again from the recording`)
      console.log(
        `rebuild: ${r ? `${r.patches} patches from ${r.stills} stills, ${r.keptPixels} px kept from the capture pass, borders ${r.seamLength} px of which ${r.seamThroughConflict} px through differing content` : 'no still frames'} in ${(performance.now() - t0).toFixed(0)} ms`,
      )
    }
    const bounds = stitcher.mosaic.exactBounds()
    if (bounds) console.log(`bounds: ${bounds.minX},${bounds.minY} .. ${bounds.maxX},${bounds.maxY}`)
    const stats = stitcher.mosaic.stats()
    console.log(
      `map: covered=${stats.covered} weak=${((100 * stats.weak) / Math.max(1, stats.covered)).toFixed(1)}% soft=${((100 * stats.soft) / Math.max(1, stats.covered)).toFixed(1)}%`,
    )
    console.log(`brightness: frames=${(frameLumSum / frameLumN).toFixed(1)}`)
    console.log(`vignette: ${Array.from(stitcher.mosaic.vignette, (v) => v.toFixed(3)).join(' ')}`)
    if (OUT) {
      writeConfidencePng(`${OUT}/replay-confidence.png`, stitcher.mosaic)
      writeLightPng(`${OUT}/replay-light.png`, stitcher.mosaic)
      writeMosaicPng(`${OUT}/replay-raw.png`, stitcher.mosaic) // before gap filling
      stitcher.mosaic.fillGaps(16) // same as Export PNG
      writeMosaicPng(`${OUT}/replay-mosaic.png`, stitcher.mosaic)
      writeMaskPng(`${OUT}/replay-mask.png`)
    }
  },
  3_600_000,
)
