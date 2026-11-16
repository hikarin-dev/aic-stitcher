import { describe, expect, it } from 'vitest'
import { ENDFIELD_VIGNETTE, TILE_SIZE, WEAK_Q } from './mosaic'
import { DEFAULT_SETTINGS, Stitcher, type StitchSettings } from './stitcher'
import { hudRects, makeWorld, renderFrame, sweepPath } from './synthetic'
import { renderMosaic } from './testing/png'

const FW = 640
const FH = 360

/** Frames carry the game's vignette by default (`vignette` overrides it). */
function run(
  settings: StitchSettings,
  opts: { lighting: boolean; speed: number; seed?: number; vignette?: number[] },
) {
  const world = makeWorld(1800, 1200, opts.seed ?? 1)
  const path = sweepPath(world.width, world.height, FW, FH, opts.speed)
  const stitcher = new Stitcher(settings)
  const vignette = opts.vignette ?? ENDFIELD_VIGNETTE
  const statuses = []
  let totalMs = 0
  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    const gain = opts.lighting ? 1 + 0.2 * Math.sin(i / 25) : 1
    const shadow = opts.lighting ? 0.25 * (0.5 + 0.5 * Math.sin(i / 40)) : 0
    const rgba = renderFrame(world, p.x, p.y, FW, FH, gain, shadow, 7, vignette)
    const st = stitcher.process({ rgba, width: FW, height: FH, timestamp: i * 33 })
    totalMs += st.processMs
    statuses.push(st)
  }
  return { world, path, stitcher, statuses, avgMs: totalMs / path.length }
}

const luma = (r: number, g: number, b: number) => (r * 77 + g * 150 + b * 29) >> 8

/** The map as displayed, as luma (−1 = empty), plus the world position of its top-left pixel. */
function shownMap(stitcher: Stitcher) {
  const m = renderMosaic(stitcher.mosaic)!
  const lum = new Int16Array(m.width * m.height)
  for (let i = 0; i < lum.length; i++) {
    lum[i] = m.rgba[i * 4 + 3] === 0 ? -1 : luma(m.rgba[i * 4], m.rgba[i * 4 + 1], m.rgba[i * 4 + 2])
  }
  return { lum, width: m.width, height: m.height, x0: m.x0, y0: m.y0 }
}

const truthAt = (world: ReturnType<typeof makeWorld>, x: number, y: number) => {
  const wi = (y * world.width + x) * 3
  return luma(world.rgb[wi], world.rgb[wi + 1], world.rgb[wi + 2])
}

/**
 * Compares the displayed map with ground truth, given the world offset of map position
 * (0,0). `mae` only counts pixels the map is confident about (not flagged weak);
 * `maeAll` counts everything.
 */
function compare(stitcher: Stitcher, world: ReturnType<typeof makeWorld>, offX: number, offY: number) {
  const shown = new Uint32Array(TILE_SIZE * TILE_SIZE)
  // [shown luma, truth, weak]
  const samples: Array<[number, number, boolean]> = []
  let ratioSum = 0
  let confident = 0
  for (const t of stitcher.mosaic.tiles.values()) {
    stitcher.mosaic.renderTile(t, shown)
    for (let y = 0; y < TILE_SIZE; y += 2) {
      for (let x = 0; x < TILE_SIZE; x += 2) {
        const li = y * TILE_SIZE + x
        if (!t.q[li]) continue
        const wx = t.tx * TILE_SIZE + x + offX
        const wy = t.ty * TILE_SIZE + y + offY
        if (wx < 0 || wy < 0 || wx >= world.width || wy >= world.height) continue
        const p = shown[li]
        const v = luma(p & 0xff, (p >>> 8) & 0xff, (p >>> 16) & 0xff)
        const truth = truthAt(world, wx, wy)
        const weak = t.q[li] < WEAK_Q
        samples.push([v, truth, weak])
        if (!weak) {
          ratioSum += v / Math.max(1, truth)
          confident++
        }
      }
    }
  }
  const scale = ratioSum / confident // the map settles on the brightest lighting it saw
  let err = 0
  let errAll = 0
  for (const [v, truth, weak] of samples) {
    const e = Math.abs(v / scale - truth)
    errAll += e
    if (!weak) err += e
  }
  return {
    covered: samples.length * 4,
    weak: (samples.length - confident) / samples.length,
    mae: err / confident,
    maeAll: errAll / samples.length,
    scale,
  }
}

/**
 * Seam visibility: mean jump of the map/truth brightness ratio between adjacent
 * 8×8 blocks. Smooth lighting drift scores ~0, hard seams between frames score high.
 */
function seamError(stitcher: Stitcher, world: ReturnType<typeof makeWorld>, offX: number, offY: number) {
  const B = 8
  const map = shownMap(stitcher)
  const bw = Math.floor(map.width / B)
  const bh = Math.floor(map.height / B)
  const ratio = new Float64Array(bw * bh).fill(NaN)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sm = 0
      let st = 0
      let n = 0
      for (let y = 0; y < B; y++) {
        for (let x = 0; x < B; x++) {
          const v = map.lum[(by * B + y) * map.width + bx * B + x]
          const gx = map.x0 + bx * B + x + offX
          const gy = map.y0 + by * B + y + offY
          if (v < 0 || gx < 0 || gy < 0 || gx >= world.width || gy >= world.height) continue
          st += truthAt(world, gx, gy)
          sm += v
          n++
        }
      }
      if (n === B * B && st > 0) ratio[by * bw + bx] = sm / st
    }
  }
  let sum = 0
  let n = 0
  for (let by = 0; by < bh - 1; by++) {
    for (let bx = 0; bx < bw - 1; bx++) {
      const r = ratio[by * bw + bx]
      for (const r2 of [ratio[by * bw + bx + 1], ratio[(by + 1) * bw + bx]]) {
        if (Number.isNaN(r) || Number.isNaN(r2)) continue
        sum += Math.abs(r - r2)
        n++
      }
    }
  }
  return (sum / n) * 100
}

describe('Stitcher (synthetic)', () => {
  it('tracks a sweep, excludes the HUD and reconstructs the map', () => {
    const settings: StitchSettings = { ...DEFAULT_SETTINGS, crop: { top: 0, bottom: 0, left: 0, right: 0 } }
    const { world, path, stitcher, statuses, avgMs } = run(settings, { lighting: false, speed: 12 })

    const firstGood = statuses.findIndex((s) => s.state === 'tracking')
    expect(firstGood).toBeGreaterThan(0)
    expect(firstGood).toBeLessThan(40)
    // Constant offset between estimated and true positions.
    const offX = path[0].x - statuses[0].x
    const offY = path[0].y - statuses[0].y
    let maxErr = 0
    let lost = 0
    for (let i = 0; i < path.length; i++) {
      const s = statuses[i]
      if (s.state === 'lost') {
        lost++
        continue
      }
      maxErr = Math.max(maxErr, Math.abs(s.x + offX - path[i].x), Math.abs(s.y + offY - path[i].y))
    }
    console.log(`frames=${path.length} lost=${lost} maxErr=${maxErr} avgMs=${avgMs.toFixed(1)}`)
    expect(lost).toBe(0)
    expect(maxErr).toBeLessThanOrEqual(1)

    const cmp = compare(stitcher, world, offX, offY)
    console.log(
      `coverage=${(cmp.covered / (world.width * world.height)).toFixed(3)} mae=${cmp.mae.toFixed(2)} maeAll=${cmp.maeAll.toFixed(2)} weak=${cmp.weak.toFixed(3)} scale=${cmp.scale.toFixed(3)}`,
    )
    expect(cmp.covered / (world.width * world.height)).toBeGreaterThan(0.85)
    // Wherever the map claims confidence it must be right. What it is less sure of
    // (only ever seen at the very edge of the screen or next to the HUD: a lot here,
    // with no crop margins and a big fake HUD) must be flagged as such.
    expect(cmp.mae).toBeLessThan(4)
    expect(cmp.weak).toBeLessThan(0.2)

    // The status reports the same confidence figures.
    const last = statuses[statuses.length - 1]
    expect(Math.abs(last.weak - cmp.weak)).toBeLessThan(0.03)
    expect(last.soft).toBeGreaterThan(0)

    // The HUD (all rects together cover ~15% of the frame) must be detected.
    const mask = stitcher.getUiMask()!
    let hudPx = 0
    let hudHit = 0
    for (const r of hudRects(FW, FH)) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          hudPx++
          hudHit += mask.mask[Math.floor(y / mask.scale) * mask.width + Math.floor(x / mask.scale)]
        }
      }
    }
    console.log(`hud recall=${(hudHit / hudPx).toFixed(3)}`)
    expect(hudHit / hudPx).toBeGreaterThan(0.97)
  }, 120000)

  it('compensates changing lighting', () => {
    const settings: StitchSettings = { ...DEFAULT_SETTINGS, crop: { top: 0, bottom: 0, left: 0, right: 0 } }
    const withCorr = run(settings, { lighting: true, speed: 12, seed: 3 })
    const without = run({ ...settings, lightingCorrection: false }, { lighting: true, speed: 12, seed: 3 })
    const offA = [withCorr.path[0].x - withCorr.statuses[0].x, withCorr.path[0].y - withCorr.statuses[0].y]
    const offB = [without.path[0].x - without.statuses[0].x, without.path[0].y - without.statuses[0].y]
    const a = seamError(withCorr.stitcher, withCorr.world, offA[0], offA[1])
    const b = seamError(without.stitcher, without.world, offB[0], offB[1])
    console.log(`seam error corrected=${a.toFixed(3)} uncorrected=${b.toFixed(3)}`)
    expect(withCorr.statuses.filter((s) => s.state === 'lost').length).toBe(0)
    // Tracking must stay exact under changing lighting too.
    const maxErr = Math.max(
      ...withCorr.statuses.map((s, i) =>
        Math.max(Math.abs(s.x + offA[0] - withCorr.path[i].x), Math.abs(s.y + offA[1] - withCorr.path[i].y)),
      ),
    )
    expect(maxErr).toBeLessThanOrEqual(1)
    expect(a).toBeLessThan(b * 0.6)
  }, 120000)

  it('learns the vignette from the frames when it differs from the built-in guess', () => {
    const settings: StitchSettings = { ...DEFAULT_SETTINGS, crop: { top: 0.05, bottom: 0.05, left: 0.02, right: 0.02 } }
    // Half as strong as the game's: the built-in guess over-corrects until it adapts.
    const truth = ENDFIELD_VIGNETTE.map((v) => v * 0.5)
    const { stitcher } = run(settings, { lighting: false, speed: 12, seed: 2, vignette: truth })
    // Darkening halfway to the corner (u = v = 0.7), in log units.
    const at = (th: ArrayLike<number>) => {
      const u2 = 0.49
      return th[0] * u2 + th[1] * u2 + th[2] * u2 * u2 + th[3] * u2 * u2 + th[4] * u2 * u2 + th[5] * 0.7 + th[6] * 0.7
    }
    const learned = at(stitcher.mosaic.vignette)
    console.log(`vignette at (0.7, 0.7): true=${at(truth).toFixed(3)} guess=${at(ENDFIELD_VIGNETTE).toFixed(3)} learned=${learned.toFixed(3)}`)
    expect(Math.abs(learned - at(truth))).toBeLessThan(0.5 * Math.abs(at(ENDFIELD_VIGNETTE) - at(truth)))
  }, 120000)

  it('draws at once when the camera stops, lets the picture settle, then leaves the stop alone', () => {
    const settings: StitchSettings = { ...DEFAULT_SETTINGS, crop: { top: 0, bottom: 0, left: 0, right: 0 } }
    const world = makeWorld(1800, 1200, 4)
    const stitcher = new Stitcher(settings)
    let i = 0
    // An item travelling along a belt: at another place in every frame.
    const frameAt = (x: number, y: number, item = -1) => {
      const rgba = renderFrame(world, x, y, FW, FH, 1, 0, 7, ENDFIELD_VIGNETTE)
      if (item >= 0) {
        for (let fy = 180; fy < 194; fy++) {
          for (let fx = 100 + 24 * item; fx < 114 + 24 * item; fx++) rgba.set([255, 0, 255, 255], (fy * FW + fx) * 4)
        }
      }
      return rgba
    }
    const step = (x: number, y: number, item = -1) =>
      stitcher.process({ rgba: frameAt(x, y, item), width: FW, height: FH, timestamp: i++ * 66 })
    // Pan right until the HUD is learned and the map has started, then stop.
    let x = 10
    let st = step(x, 300)
    while (st.state !== 'tracking' || !st.composited) st = step((x += 12), 300)
    for (let k = 0; k < 6; k++) st = step((x += 12), 300)
    const modes: Array<string | null> = []
    for (let k = 0; k < 20; k++) {
      st = step(x, 300, k)
      modes.push(st.drawMode)
    }
    // The first frame at rest is a full draw from the sharpest kind of frame...
    expect(modes[0]).toBe('still')
    // ...the next ones replace it while the picture settles (0.6 s, at 66 ms a frame)...
    const last = modes.lastIndexOf('still')
    expect(modes.filter((m) => m === 'still').length).toBeGreaterThanOrEqual(4)
    expect(last).toBeGreaterThanOrEqual(8)
    // ...and then the stop has its picture, however long it lasts.
    expect(last).toBeLessThan(12)
    // One picture: the item is on the map once, where the last of those frames had it.
    const map = renderMosaic(stitcher.mosaic)!
    // (Where the map is far from what the world looks like there: the item.)
    const plain = frameAt(x, 300)
    const seen: number[] = []
    for (let k = 0; k < 20; k++) {
      const f = (187 * FW + 107 + 24 * k) * 4
      const m = ((st.y + 187 - map.y0) * map.width + (st.x + 107 + 24 * k - map.x0)) * 4
      let diff = 0
      for (let c = 0; c < 3; c++) diff += Math.abs(map.rgba[m + c] - plain[f + c])
      if (diff > 200) seen.push(k)
    }
    expect(seen).toEqual([last])
    // Holes are filled by any frame, even one that otherwise would not be drawn.
    const before = stitcher.mosaic.stats().covered
    const moved = step(x + 17, 300) // too small a step for a normal draw
    expect(moved.drawMode).toBe('fill')
    expect(stitcher.mosaic.stats().covered).toBeGreaterThan(before)
  }, 120000)

  it('relocalizes after a jump to an already-mapped area (fast mouse drag)', () => {
    const settings: StitchSettings = { ...DEFAULT_SETTINGS, crop: { top: 0, bottom: 0, left: 0, right: 0 } }
    const { world, path, stitcher, statuses } = run(settings, { lighting: false, speed: 12, seed: 5 })
    const offX = path[0].x - statuses[0].x
    const offY = path[0].y - statuses[0].y
    // Teleport to a few far-away spots on the map that were swept earlier.
    const jumps = [path[40], path[Math.floor(path.length / 2)], path[200], path[10]]
    let t = path.length
    for (const p of jumps) {
      const st = stitcher.process({
        rgba: renderFrame(world, p.x + 3, p.y + 2, FW, FH, 1, 0, 7, ENDFIELD_VIGNETTE),
        width: FW,
        height: FH,
        timestamp: t++ * 33,
      })
      console.log('jump ->', st.state, st.x + offX, st.y + offY, 'expected', p.x + 3, p.y + 2, st.timings)
      expect(st.state).toBe('tracking')
      expect(Math.abs(st.x + offX - (p.x + 3))).toBeLessThanOrEqual(1)
      expect(Math.abs(st.y + offY - (p.y + 2))).toBeLessThanOrEqual(1)
    }
  }, 120000)
})
