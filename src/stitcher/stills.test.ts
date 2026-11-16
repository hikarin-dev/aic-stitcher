import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENDFIELD_VIGNETTE, TILE_SIZE, WEAK_Q } from './mosaic'
import { KeyframeStore, PLAN_CELL, planPatches, type Keyframe, type PlanFrame } from './stills'
import { DEFAULT_SETTINGS, Stitcher, type StitchSettings } from './stitcher'
import { hudRects, makeWorld, renderFrame } from './synthetic'
import { readPng, writeMosaicPng, writePng } from './testing/png'

const FW = 640
const FH = 360
const OUT = process.env.DEBUG_OUT
const NO_CROP: StitchSettings = { ...DEFAULT_SETTINGS, crop: { top: 0, bottom: 0, left: 0, right: 0 } }

const luma = (r: number, g: number, b: number) => (r * 77 + g * 150 + b * 29) >> 8

/** Mean absolute error of the displayed map against the world, over confident pixels. */
function mapError(stitcher: Stitcher, world: ReturnType<typeof makeWorld>, offX: number, offY: number) {
  const shown = new Uint32Array(TILE_SIZE * TILE_SIZE)
  const samples: Array<[number, number]> = []
  let ratio = 0
  let covered = 0
  for (const t of stitcher.mosaic.tiles.values()) {
    stitcher.mosaic.renderTile(t, shown)
    for (let y = 0; y < TILE_SIZE; y += 2) {
      for (let x = 0; x < TILE_SIZE; x += 2) {
        const li = y * TILE_SIZE + x
        if (!t.q[li]) continue
        covered++
        if (t.q[li] < WEAK_Q) continue
        const wx = t.tx * TILE_SIZE + x + offX
        const wy = t.ty * TILE_SIZE + y + offY
        if (wx < 0 || wy < 0 || wx >= world.width || wy >= world.height) continue
        const wi = (wy * world.width + wx) * 3
        const truth = luma(world.rgb[wi], world.rgb[wi + 1], world.rgb[wi + 2])
        const p = shown[li]
        const v = luma(p & 0xff, (p >>> 8) & 0xff, (p >>> 16) & 0xff)
        samples.push([v, truth])
        ratio += v / Math.max(1, truth)
      }
    }
  }
  const scale = ratio / samples.length
  let err = 0
  for (const [v, truth] of samples) err += Math.abs(v / scale - truth)
  return { mae: err / samples.length, covered: covered * 4 }
}

describe('still frames', () => {
  it('plans one patch per distinct stop, and leaves out frames that add nothing', () => {
    // A frame of 12×6 planning cells; its core is everything but a one-cell rim.
    const frame = (x: number, y: number, weight = 1, core = true): PlanFrame => {
      const cols = 12
      const rows = 6
      const mask = new Uint8Array(cols * rows)
      const reach = new Uint8Array(cols * rows).fill(1)
      if (core) for (let cy = 1; cy < rows - 1; cy++) for (let cx = 1; cx < cols - 1; cx++) mask[cy * cols + cx] = 1
      return { x: x * PLAN_CELL, y: y * PLAN_CELL, cols, rows, core: mask, reach, weight }
    }
    // Two frames from (nearly) the same place: only the better one is used.
    const twins = planPatches([frame(0, 0, 0.1), frame(1, 0, 0.5), frame(10, 0)])
    expect(twins.patches.slice().sort()).toEqual([1, 2])
    expect(twins.fillers).toEqual([0])
    // A stop between two others adds no new ground, but it is the nearest view of the
    // ground around its own middle: it is used too, after the ones that add ground.
    const between = planPatches([frame(0, 0), frame(8, 0), frame(4, 0)])
    expect(between.patches).toEqual([0, 1, 2])
    // A frame that only adds outskirts (nothing in its core is new) gets in for those.
    expect(planPatches([frame(0, 0), frame(0, 3)]).patches).toEqual([0, 1])
    // A frame with no usable core and nothing new to show is left out.
    const useless = planPatches([frame(0, 0), frame(4, 0), frame(2, 0, 1, false)])
    expect(useless.patches).toEqual([0, 1])
    expect(useless.fillers).toEqual([2])
  })

  it('makes room by dropping the most redundant frame, or just its pixels if they can be read again', () => {
    const frame = (x: number, key: number | null): Keyframe => ({
      rgba32: new Uint32Array(1000),
      width: 40,
      height: 25,
      x,
      y: 0,
      valid: new Uint8Array(10),
      fresh: null,
      settled: 1,
      key,
    })
    // Live capture: frames can't be had again.
    const live = new KeyframeStore()
    live.maxBytes = 3 * 4010
    for (const x of [0, 500, 1000]) expect(live.add(frame(x, null))).toBe(true)
    // A frame close to an existing one: one of that pair has to go, the spread-out ones stay.
    live.add(frame(520, null))
    expect(live.frames).toHaveLength(3)
    expect(live.frames.map((f) => f.x).filter((x) => x === 0 || x === 1000)).toEqual([0, 1000])
    expect(live.evicted).toBe(1)

    // A recording: every frame stays on the books, only pixels go.
    // (A frame without pixels still takes a few bytes for its masks.)
    const file = new KeyframeStore()
    file.maxBytes = 3 * 4010 + 100
    for (const x of [0, 500, 1000, 520, 1500]) expect(file.add(frame(x, x))).toBe(true)
    expect(file.frames).toHaveLength(5)
    expect(file.frames.filter((f) => f.rgba32).length).toBe(3)
    expect(file.evicted).toBe(0)
    expect(file.bytes).toBeLessThanOrEqual(file.maxBytes)

    // The recording is closed: what was kept without pixels is gone, and the rest
    // can't be asked for again (the next recording has other frames at those times).
    file.forgetKeys()
    expect(file.frames).toHaveLength(3)
    expect(file.frames.every((f) => f.rgba32 !== null && f.key === null)).toBe(true)
    expect(file.evicted).toBe(2)
  })

  it('stitches screenshots given in any order, learning the HUD from them', () => {
    // Screenshot-sized frames: matching works on a coarse thumbnail first, and the
    // 640×360 frames of the other tests are only 20×11 thumbnail pixels.
    const IW = 960
    const IH = 540
    const world = makeWorld(2000, 1150, 6)
    // A 3×3 grid of views overlapping by a bit more than half, shuffled.
    const views: Array<{ x: number; y: number }> = []
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) views.push({ x: 20 + c * 420, y: 15 + r * 230 })
    const order = [4, 0, 8, 2, 6, 1, 7, 3, 5]
    const images = order.map((k) => ({
      rgba: renderFrame(world, views[k].x, views[k].y, IW, IH, 1, 0, 7, ENDFIELD_VIGNETTE),
      width: IW,
      height: IH,
    }))
    const stitcher = new Stitcher(NO_CROP)
    const result = stitcher.stitchImages(images)
    expect(result.skipped).toEqual([])
    expect(result.placed).toBe(9)
    expect(result.hudLearned).toBe(true)

    // The fake HUD's panels are found without any motion to go by.
    const mask = stitcher.getStillMask()!
    const scale = stitcher.getUiMask()!.scale
    const mw = stitcher.getUiMask()!.width
    let hud = 0
    let hit = 0
    for (const r of hudRects(IW, IH)) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          hud++
          hit += mask[Math.floor(y / scale) * mw + Math.floor(x / scale)]
        }
      }
    }
    let masked = 0
    for (const v of mask) masked += v
    console.log(`hud recall=${(hit / hud).toFixed(3)} masked=${(masked / mask.length).toFixed(3)}`)
    expect(hit / hud).toBeGreaterThan(0.9)
    expect(masked / mask.length).toBeLessThan(0.4) // ...and the world is not

    // The first image given (view 4) sits at the map's origin.
    const area = (2 * 420 + IW) * (2 * 230 + IH)
    const cmp = mapError(stitcher, world, views[4].x, views[4].y)
    console.log(`images: mae=${cmp.mae.toFixed(2)} coverage=${(cmp.covered / area).toFixed(3)}`)
    expect(cmp.mae).toBeLessThan(4)
    expect(cmp.covered / area).toBeGreaterThan(0.8)
    if (OUT) writeMosaicPng(`${OUT}/stills-synthetic.png`, stitcher.mosaic)
  }, 120000)

  it('takes screenshots one at a time, learning the HUD once there are two', () => {
    const IW = 960
    const IH = 540
    const world = makeWorld(2000, 1150, 12)
    const views = [{ x: 30, y: 20 }, { x: 430, y: 150 }, { x: 60, y: 330 }, { x: 520, y: 400 }]
    const stitcher = new Stitcher(NO_CROP)
    const results = views.map((v) =>
      stitcher.stitchImages([{ rgba: renderFrame(world, v.x, v.y, IW, IH, 1, 0, 7, ENDFIELD_VIGNETTE), width: IW, height: IH }]),
    )
    expect(results.map((r) => r.placed)).toEqual([1, 1, 1, 1])
    expect(results.map((r) => r.hudLearned)).toEqual([false, true, true, true])
    expect(stitcher.keyframeCount).toBe(4)
    // The first image went in with its HUD; the later ones let the map get rid of it.
    const cmp = mapError(stitcher, world, views[0].x, views[0].y)
    console.log(`one at a time: mae=${cmp.mae.toFixed(2)}`)
    expect(cmp.mae).toBeLessThan(4)
  }, 120000)

  it('reports images that fit nowhere instead of guessing', () => {
    const world = makeWorld(1500, 1000, 6)
    const other = makeWorld(900, 600, 99)
    const at = (w: typeof world, x: number, y: number) => ({
      rgba: renderFrame(w, x, y, FW, FH, 1, 0, 7, ENDFIELD_VIGNETTE),
      width: FW,
      height: FH,
    })
    const stitcher = new Stitcher(NO_CROP)
    const result = stitcher.stitchImages([
      at(world, 20, 20),
      at(world, 270, 90),
      at(other, 50, 50), // somewhere else entirely
      { rgba: new Uint8ClampedArray(320 * 200 * 4), width: 320, height: 200 }, // wrong size
    ])
    expect(result.placed).toBe(2)
    expect(result.skipped.map((s) => s.index).sort()).toEqual([2, 3])

    // Two images are enough, too.
    const pair = new Stitcher(NO_CROP)
    expect(pair.stitchImages([at(world, 20, 20), at(world, 220, 120)]).placed).toBe(2)
  }, 120000)

  it('rebuilds the map from the still frames of a pan in large patches', () => {
    const world = makeWorld(1800, 900, 8)
    const stitcher = new Stitcher(NO_CROP)
    let t = 0
    const step = (x: number, y: number) =>
      stitcher.process({
        rgba: renderFrame(world, x, y, FW, FH, 1, 0, 7, ENDFIELD_VIGNETTE),
        width: FW,
        height: FH,
        timestamp: t++ * 66,
      })
    // Pan right in bursts, stopping for half a second after each, then come back lower down.
    let x = 10
    let y = 10
    const start = step(x, y)
    const burst = (dx: number, dy: number, frames: number) => {
      for (let k = 0; k < frames; k++) step((x += dx), (y += dy))
      for (let k = 0; k < 9; k++) step(x, y)
    }
    for (let k = 0; k < 5; k++) burst(20, 0, 12)
    burst(0, 20, 9)
    for (let k = 0; k < 5; k++) burst(-20, 0, 12)
    const offX = 10 - start.x
    const offY = 10 - start.y

    const before = mapError(stitcher, world, offX, offY)
    const stills = stitcher.keyframeCount
    expect(stills).toBeGreaterThanOrEqual(8)
    const result = stitcher.rebuildFromStills()!
    const after = mapError(stitcher, world, offX, offY)
    console.log(
      `rebuild: stills=${result.stills} patches=${result.patches} kept=${result.keptPixels} mae ${before.mae.toFixed(2)} -> ${after.mae.toFixed(2)}`,
    )
    expect(result.stills).toBe(stills)
    expect(result.patches).toBeGreaterThan(0)
    expect(result.patches).toBeLessThanOrEqual(stills)
    // Nothing is lost, and the map is still right.
    expect(after.covered).toBeGreaterThanOrEqual(before.covered)
    expect(after.mae).toBeLessThan(4)
    // Tracking carries on against the rebuilt map.
    const next = step(x + 15, y)
    expect(next.state).toBe('tracking')
    expect(next.x + offX).toBe(x + 15)
  }, 120000)
})

/** Sample screenshots, when present: samples/*.png in the repository root, or SAMPLES_DIR. */
const SAMPLES = process.env.SAMPLES_DIR ?? join(process.cwd(), 'samples')
const sampleFiles = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => f.endsWith('.png')).sort() : []

it.runIf(sampleFiles.length >= 2)(
  'stitches the sample screenshots',
  () => {
    const images = sampleFiles.map((f) => readPng(join(SAMPLES, f)))
    const stitcher = new Stitcher(DEFAULT_SETTINGS)
    const t0 = performance.now()
    const result = stitcher.stitchImages(images)
    const b = stitcher.mosaic.exactBounds()!
    const stats = stitcher.mosaic.stats()
    console.log(
      `samples: placed ${result.placed}/${result.total} in ${(performance.now() - t0).toFixed(0)} ms, map ${b.maxX - b.minX}×${b.maxY - b.minY}, weak ${((100 * stats.weak) / stats.covered).toFixed(1)}%`,
      result.skipped,
    )
    expect(result.placed).toBe(images.length)
    // Together they cover clearly more than one screenshot does.
    expect((b.maxX - b.minX) * (b.maxY - b.minY)).toBeGreaterThan(1.4 * images[0].width * images[0].height)
    if (OUT) {
      stitcher.mosaic.fillGaps(16)
      writeMosaicPng(`${OUT}/samples-stitched.png`, stitcher.mosaic)
      const mask = stitcher.getStillMask()
      const m = stitcher.getUiMask()!
      if (mask) {
        const img = new Uint8ClampedArray(m.width * m.height * 4)
        for (let i = 0; i < mask.length; i++) {
          img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = mask[i] ? 255 : 0
          img[i * 4 + 3] = 255
        }
        writePng(`${OUT}/samples-mask.png`, img, m.width, m.height)
      }
    }
  },
  300000,
)
