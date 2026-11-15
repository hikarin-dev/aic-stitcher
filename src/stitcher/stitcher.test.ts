import { describe, expect, it } from 'vitest'
import { TILE_SIZE } from './mosaic'
import { DEFAULT_SETTINGS, Stitcher, type StitchSettings } from './stitcher'
import { hudRects, makeWorld, renderFrame, sweepPath } from './synthetic'

const FW = 640
const FH = 360

function run(settings: StitchSettings, opts: { lighting: boolean; speed: number; seed?: number }) {
  const world = makeWorld(1800, 1200, opts.seed ?? 1)
  const path = sweepPath(world.width, world.height, FW, FH, opts.speed)
  const stitcher = new Stitcher(settings)
  const statuses = []
  let totalMs = 0
  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    const gain = opts.lighting ? 1 + 0.2 * Math.sin(i / 25) : 1
    const shadow = opts.lighting ? 0.25 * (0.5 + 0.5 * Math.sin(i / 40)) : 0
    const rgba = renderFrame(world, p.x, p.y, FW, FH, gain, shadow)
    const st = stitcher.process({ rgba, width: FW, height: FH, timestamp: i * 33 })
    totalMs += st.processMs
    statuses.push(st)
  }
  return { world, path, stitcher, statuses, avgMs: totalMs / path.length }
}

/** Compares the mosaic with ground truth, given the world offset of mosaic (0,0). */
function compare(stitcher: Stitcher, world: ReturnType<typeof makeWorld>, offX: number, offY: number) {
  let covered = 0
  let absErr = 0
  let ratioSum = 0
  const samples: Array<[number, number]> = []
  for (const t of stitcher.mosaic.tiles.values()) {
    for (let y = 0; y < TILE_SIZE; y += 2) {
      for (let x = 0; x < TILE_SIZE; x += 2) {
        const li = y * TILE_SIZE + x
        if (!t.q[li]) continue
        const wx = t.tx * TILE_SIZE + x + offX
        const wy = t.ty * TILE_SIZE + y + offY
        if (wx < 0 || wy < 0 || wx >= world.width || wy >= world.height) continue
        const wi = (wy * world.width + wx) * 3
        const truth = (world.rgb[wi] * 77 + world.rgb[wi + 1] * 150 + world.rgb[wi + 2] * 29) >> 8
        samples.push([t.lum[li], truth])
        ratioSum += t.lum[li] / Math.max(1, truth)
        covered++
      }
    }
  }
  const scale = ratioSum / covered // mosaic is normalised to whatever lighting the first frame had
  for (const [m, tr] of samples) absErr += Math.abs(m / scale - tr)
  return { covered: covered * 4, mae: absErr / covered, scale }
}

/**
 * Seam visibility: mean jump of the mosaic/truth brightness ratio between adjacent
 * 8×8 blocks. Smooth lighting drift scores ~0, hard seams between frames score high.
 */
function seamError(stitcher: Stitcher, world: ReturnType<typeof makeWorld>, offX: number, offY: number) {
  const B = 8
  const bnd = stitcher.mosaic.exactBounds()!
  const bw = Math.floor((bnd.maxX - bnd.minX) / B)
  const bh = Math.floor((bnd.maxY - bnd.minY) / B)
  const ratio = new Float64Array(bw * bh).fill(NaN)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sm = 0
      let st = 0
      let n = 0
      for (let y = 0; y < B; y++) {
        for (let x = 0; x < B; x++) {
          const wx = bnd.minX + bx * B + x
          const wy = bnd.minY + by * B + y
          const t = stitcher.mosaic.getTile(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE))
          if (!t) continue
          const li = (wy - t.ty * TILE_SIZE) * TILE_SIZE + (wx - t.tx * TILE_SIZE)
          const gx = wx + offX
          const gy = wy + offY
          if (!t.q[li] || gx < 0 || gy < 0 || gx >= world.width || gy >= world.height) continue
          const wi = (gy * world.width + gx) * 3
          st += (world.rgb[wi] * 77 + world.rgb[wi + 1] * 150 + world.rgb[wi + 2] * 29) >> 8
          sm += t.lum[li]
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
    console.log(`coverage=${(cmp.covered / (world.width * world.height)).toFixed(3)} mae=${cmp.mae.toFixed(2)}`)
    expect(cmp.covered / (world.width * world.height)).toBeGreaterThan(0.85)
    expect(cmp.mae).toBeLessThan(4)

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
        rgba: renderFrame(world, p.x + 3, p.y + 2, FW, FH, 1, 0),
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
