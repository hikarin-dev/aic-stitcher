/**
 * Dev helper: replays a screen recording through the stitcher (needs ffmpeg on PATH).
 *   REPLAY=path/to/video.webm [REPLAY_FPS=15] [REPLAY_WIDTH=1920] [DEBUG_OUT=dir] [REPLAY_PASS2=fwd|rev] \
 *     npx vitest run src/stitcher/replay.test.ts --silent=false
 * Logs every frame's tracking result and, with DEBUG_OUT, writes the final map.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { DEFAULT_SETTINGS, Stitcher } from './stitcher'
import { writeMosaicPng, writePng } from './testing/png'

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

it.runIf(!!SRC)(
  'replay recording',
  async () => {
    const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', SRC!])
    let probeOut = ''
    probe.stdout.on('data', (d) => (probeOut += d))
    await new Promise((r) => probe.on('close', r))
    const [sw, sh] = probeOut.trim().split(',').map(Number)
    const w = Math.min(WIDTH, sw)
    const h = Math.round((sh * w) / sw / 2) * 2
    console.log(`source ${sw}x${sh} -> ${w}x${h} @ ${FPS} fps`)

    const ff = spawn('ffmpeg', ['-v', 'error', '-i', SRC!, '-vf', `fps=${FPS},scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    const frameBytes = w * h * 4
    const stitcher = new Stitcher({ ...DEFAULT_SETTINGS, crop: { top: 0.1, bottom: 0.1, left: 0.02, right: 0.02 } })
    let buf = Buffer.alloc(0)
    let index = 0
    let lost = 0
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
    const handle = (frame: Uint8Array) => {
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
      const st = stitcher.process({ rgba, width: w, height: h, timestamp: (index * 1000) / FPS })
      total += st.processMs
      for (const [k, v] of Object.entries(st.timings)) timing[k] = (timing[k] ?? 0) + v
      if (st.state === 'lost') lost++
      if (calibEnd < 0 && st.state !== 'calibrating') calibEnd = index
      console.log(
        `${String(index).padStart(4)} ${st.state.padEnd(11)} pos=${st.x},${st.y} match=${st.matchScore?.toFixed(3) ?? '-'} gain=${st.gain.toFixed(3)} ${st.composited ? 'drawn' : ''} ${st.processMs.toFixed(0)}ms`,
      )
      if (OUT && DUMP.has(index)) writePng(`${OUT}/replay-frame-${index}.png`, rgba, w, h)
      index++
    }
    ff.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= frameBytes) {
        if (index >= MAX_FRAMES) {
          ff.kill()
          buf = Buffer.alloc(0)
          break
        }
        handle(buf.subarray(0, frameBytes))
        buf = buf.subarray(frameBytes)
      }
    })
    await new Promise((r) => ff.on('close', r))
    const pass1Frames = index
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
      `frames=${index} lost=${lost} avgMs=${(total / index).toFixed(1)}`,
      Object.entries(timing).map(([k, v]) => `${k}=${(v / index).toFixed(1)}`).join(' '),
    )
    let mapLumSum = 0
    let mapLumN = 0
    for (const t of stitcher.mosaic.tiles.values()) {
      for (let i = 0; i < t.q.length; i += 7) {
        if (!t.q[i]) continue
        mapLumSum += t.lum[i]
        mapLumN++
      }
    }
    console.log(
      `brightness: frames=${(frameLumSum / frameLumN).toFixed(1)} map=${(mapLumSum / mapLumN).toFixed(1)} ratio=${(mapLumSum / mapLumN / (frameLumSum / frameLumN)).toFixed(3)}`,
    )
    if (OUT) {
      stitcher.mosaic.fillGaps(16) // same as Export PNG
      writeMosaicPng(`${OUT}/replay-mosaic.png`, stitcher.mosaic)
      const m = stitcher.getUiMask()!
      const img = new Uint8ClampedArray(m.width * m.height * 4)
      for (let i = 0; i < m.mask.length; i++) {
        img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = m.mask[i] ? 255 : 0
        img[i * 4 + 3] = 255
      }
      writePng(`${OUT}/replay-mask.png`, img, m.width, m.height)
    }
  },
  3_600_000,
)
