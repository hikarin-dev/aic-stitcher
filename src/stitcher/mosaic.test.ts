import { describe, expect, it } from 'vitest'
import { Mosaic, SHARP_Q, TILE_SIZE, WEAK_Q, type CompositeInput } from './mosaic'

const grey = (v: number) => (0xff000000 | (v << 16) | (v << 8) | v) >>> 0

/** These tests feed frames without a vignette. */
function newMosaic(): Mosaic {
  const m = new Mosaic()
  m.vignette.fill(0)
  m.learnVignette = false
  return m
}

/** A W×H frame of flat grey (100) with quality from `q`, optionally with painted rectangles. */
function frame(
  w: number,
  h: number,
  q: (x: number, y: number) => number,
  rects: Array<{ x: number; y: number; w: number; h: number; v: number }> = [],
  over: Partial<CompositeInput> = {},
): Omit<CompositeInput, 'x' | 'y'> {
  const rgba32 = new Uint32Array(w * h).fill(grey(100))
  const lum = new Uint8Array(w * h).fill(100)
  const qa = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) qa[y * w + x] = q(x, y)
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        rgba32[y * w + x] = grey(r.v)
        lum[y * w + x] = r.v
      }
    }
  }
  return {
    rgba32,
    lum,
    q: qa,
    width: w,
    height: h,
    // Uniform lighting: one shade cell covering the whole frame.
    shade: new Float32Array([100]),
    shadeWeight: new Float32Array([1]),
    shadeW: 1,
    shadeH: 1,
    shadeScale: Math.max(w, h),
    speedFactor: 1,
    confirm: true,
    ...over,
  }
}

/** A flat frame of the given brightness with a real (feathered) lighting grid, like the stitcher builds. */
function litFrame(w: number, h: number, brightness: number): Omit<CompositeInput, 'x' | 'y'> {
  const S = 8
  const sw = w / S
  const sh = h / S
  const shade = new Float32Array(sw * sh).fill(brightness)
  const weight = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const t = Math.min(1, (Math.min(x, y, sw - 1 - x, sh - 1 - y) + 0.5) / 5)
      weight[y * sw + x] = t * t * (3 - 2 * t)
    }
  }
  return {
    rgba32: new Uint32Array(w * h).fill(grey(brightness)),
    lum: new Uint8Array(w * h).fill(brightness),
    q: new Uint8Array(w * h).fill(200),
    width: w,
    height: h,
    shade,
    shadeWeight: weight,
    shadeW: sw,
    shadeH: sh,
    shadeScale: S,
    speedFactor: 1,
    confirm: true,
  }
}

/** The stored (detail-layer) sample at a world pixel. */
const rawAt = (m: Mosaic, x: number, y: number) => {
  const t = m.getTile(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))!
  return t.raw32[(y - t.ty * TILE_SIZE) * TILE_SIZE + (x - t.tx * TILE_SIZE)] & 0xff
}

/** One row of the displayed map (tile 0,0). */
function shownRow(m: Mosaic, y: number, x0: number, x1: number): number[] {
  const out = new Uint32Array(TILE_SIZE * TILE_SIZE)
  m.renderTile(m.getTile(0, 0)!, out)
  const row: number[] = []
  for (let x = x0; x < x1; x++) row.push(out[y * TILE_SIZE + x] & 0xff)
  return row
}

const maxStep = (row: number[]) => Math.max(...row.slice(1).map((v, i) => Math.abs(v - row[i])))

describe('Mosaic', () => {
  it('writes across tile boundaries and fills thin gaps only', () => {
    const m = newMosaic()
    // 4px-wide vertical hole at x 498..501 (straddles tiles), and a 40px hole at 600..639.
    const hole = (x: number) => (x >= 498 && x < 502) || (x >= 600 && x < 640)
    m.composite({ ...frame(700, 20, (x) => (hole(x) ? 0 : 200)), x: 0, y: 0 })
    expect(m.tiles.size).toBe(2)
    expect(m.fillGaps(16)).toBe(4 * 20)
    expect(m.getTile(0, 0)!.q[500]).toBe(1)
    expect(m.getTile(1, 0)!.q[600 - TILE_SIZE]).toBe(0)
  })

  it('fills holes from any frame without touching what is there (fill mode)', () => {
    const m = newMosaic()
    m.composite({ ...frame(120, 60, () => 100), x: 0, y: 0 })
    const other = frame(120, 60, () => 255, [{ x: 0, y: 0, w: 120, h: 60, v: 50 }], { mode: 'fill' })
    const res = m.composite({ ...other, x: 60, y: 0 })
    expect(res.filled).toBe(60 * 60)
    expect(rawAt(m, 90, 30)).toBe(100) // already covered: untouched, although the frame is better
    expect(rawAt(m, 150, 30)).toBe(50) // was a hole
  })

  it('takes an animated object entirely from one frame, never half/half', () => {
    const m = newMosaic()
    // Frame A: object (lum 200) at x 40..80, quality rising to the right.
    m.composite({ ...frame(120, 60, (x) => 50 + x, [{ x: 40, y: 20, w: 40, h: 20, v: 200 }]), x: 0, y: 0 })
    // Frame B: same object in another animation state (lum 30), quality rising to the left,
    // so per-pixel "best quality" would split the object down the middle.
    m.composite({ ...frame(120, 60, (x) => 170 - x, [{ x: 40, y: 20, w: 40, h: 20, v: 30 }]), x: 0, y: 0 })
    const values = new Set<number>()
    for (let x = 40; x < 80; x++) values.add(rawAt(m, x, 30))
    expect(values.size).toBe(1)
  })

  it('keeps one sample of an animated object: only a clearly better look replaces it, and then whole', () => {
    const m = newMosaic()
    m.composite({ ...frame(120, 60, () => 150, [{ x: 40, y: 20, w: 40, h: 20, v: 200 }]), x: 0, y: 0 })
    // Another animation state, seen just as well: the stored sample stays.
    m.composite({ ...frame(120, 60, () => 150, [{ x: 40, y: 20, w: 40, h: 20, v: 30 }]), x: 0, y: 0 })
    for (let x = 40; x < 80; x++) expect(rawAt(m, x, 30)).toBe(200)
    // A sharp look (camera standing still): replaces the whole object.
    m.composite({ ...frame(120, 60, () => 255, [{ x: 40, y: 20, w: 40, h: 20, v: 30 }]), x: 0, y: 0 })
    for (let x = 40; x < 80; x++) expect(rawAt(m, x, 30)).toBe(30)
  })

  it('makes one picture of a stop, however many frames it lasts', () => {
    // A belt: an item (220) travels along it. The first frame after stopping is good
    // on the left half only (the right half has just scrolled in); later ones all over.
    const item = (x: number) => [{ x, y: 20, w: 10, h: 10, v: 220 }]
    const stop = [
      frame(240, 60, (x) => (x < 120 ? 200 : 60), item(20)),
      frame(240, 60, () => 200, [...item(70), ...item(190)]),
      frame(240, 60, () => 200, [...item(100), ...item(220)]),
    ]
    const build = (own?: Uint8Array) => {
      const m = newMosaic()
      // What a pan left behind: a blurry look at the empty belt.
      m.composite({ ...frame(240, 60, () => 100), x: 0, y: 0 })
      for (const f of stop) m.composite({ ...f, own, confirm: false, x: 0, y: 0 })
      const items: number[] = []
      for (let x = 0; x < 240; x += 10) if (rawAt(m, x + 5, 25) === 220) items.push(x)
      return items
    }
    // Frame by frame, each pixel keeps the first good look it got: the left half is the
    // first frame, the right half the second, and the item is on the belt twice.
    expect(build()).toEqual([20, 190])
    // As one stop: the last frame, all of it.
    expect(build(new Uint8Array(240 * 60))).toEqual([100, 220])
  })

  it('does not overwrite an object with a copy cut off by the frame edge', () => {
    const m = newMosaic()
    m.composite({ ...frame(120, 60, () => 200, [{ x: 40, y: 20, w: 40, h: 20, v: 200 }]), x: 0, y: 0 })
    // New frame shifted so the object (now in another state) touches its left edge, higher quality.
    m.composite({ ...frame(120, 60, () => 250, [{ x: 0, y: 20, w: 20, h: 20, v: 30 }]), x: 60, y: 0 })
    for (let x = 40; x < 80; x++) expect(rawAt(m, x, 30)).toBe(200)
  })

  it('replaces one-off content from a blurry frame, but keeps settled content', () => {
    const m = newMosaic()
    // Fast frame (drag) with a cursor: stored with low quality.
    const fast = frame(120, 60, () => 200, [{ x: 50, y: 20, w: 12, h: 16, v: 250 }], { speedFactor: 0.5, confirm: false })
    m.composite({ ...fast, x: 0, y: 0 })
    expect(rawAt(m, 55, 28)).toBe(250)
    // Slow frame without the cursor: replaces it.
    m.composite({ ...frame(120, 60, () => 200), x: 0, y: 0 })
    expect(rawAt(m, 55, 28)).toBe(100)

    // Content that several good frames agreed on survives a disagreeing frame, even a sharper one.
    const c = newMosaic()
    for (let i = 0; i < 3; i++) {
      c.composite({ ...frame(120, 60, () => 200, [{ x: 50, y: 20, w: 12, h: 16, v: 250 }]), x: 0, y: 0 })
    }
    c.composite({ ...frame(120, 60, () => 255), x: 0, y: 0 })
    expect(rawAt(c, 55, 28)).toBe(250)
  })

  it('throws out what sat on the screen during a stop once two frames from elsewhere agree against it', () => {
    const m = newMosaic()
    // Camera standing still, mouse cursor in view: the sharpest frame there is.
    m.composite({ ...frame(120, 60, () => 255, [{ x: 50, y: 20, w: 12, h: 16, v: 250 }]), x: 0, y: 0 })
    const moving = () => frame(120, 60, () => 255, [], { speedFactor: 0.6 })
    // First frame after the camera moves on: blurrier, and nothing backs it up yet.
    m.composite({ ...moving(), x: 10, y: 0 })
    expect(rawAt(m, 55, 28)).toBe(250)
    // The next one sees the same plain ground there: two independent looks against one.
    const res = m.composite({ ...moving(), x: 20, y: 0 })
    expect(rawAt(m, 55, 28)).toBe(100)
    // ...and says where, for the still frames that were kept of that stop.
    expect(res.transients).toHaveLength(1)
    const box = res.transients![0]
    expect(box.x <= 50 && box.y <= 20 && box.x + box.w >= 62 && box.y + box.h >= 36).toBe(true)
  })

  it('leaves out of a still what the capture found to be the cursor', () => {
    const cursor = { x: 50, y: 20, w: 12, h: 16, v: 250 }
    const icon = { x: 90, y: 30, w: 12, h: 12, v: 30 }
    const build = (told: boolean) => {
      const m = newMosaic()
      // What the capture ended up with: a blurry look, without the cursor (thrown out),
      // and without the icon (hidden at the screen edge).
      m.composite({ ...frame(120, 60, () => 150, [], { speedFactor: 0.6 }), x: 0, y: 0 })
      m.prepareAssembly()
      const still = frame(120, 60, () => 255, [cursor, icon])
      const rating = new Uint8Array(120 * 60).fill(200)
      m.assemble({ ...still, x: 0, y: 0, rating, suspects: told ? [{ x: 50, y: 20, w: 12, h: 16 }] : undefined })
      m.finishAssembly()
      return { cursor: rawAt(m, 55, 28), icon: rawAt(m, 95, 35) }
    }
    // The still is the better view by far: all of it goes in, cursor included...
    expect(build(false)).toEqual({ cursor: 250, icon: 30 })
    // ...unless it was told where the capture had found one.
    expect(build(true)).toEqual({ cursor: 100, icon: 30 })
  })

  it('joins frames taken under different lighting without a brightness step', () => {
    const blended = newMosaic()
    const plain = newMosaic()
    plain.blendLighting = false
    for (const m of [blended, plain]) {
      m.composite({ ...litFrame(240, 120, 100), x: 0, y: 0 })
      m.composite({ ...litFrame(240, 120, 140), x: 120, y: 0 }) // a brighter moment, half overlapping
    }
    // Without the lighting layer the second frame's new strip starts with a hard step.
    expect(maxStep(shownRow(plain, 60, 4, 356))).toBeGreaterThanOrEqual(30)
    const row = shownRow(blended, 60, 4, 356)
    expect(maxStep(row)).toBeLessThanOrEqual(3)
    // ...and the far end shows the brighter moment.
    expect(row[row.length - 1]).toBeGreaterThan(135)
  })

  it('reports how well each part of the map was captured', () => {
    const m = newMosaic()
    m.composite({ ...frame(256, 64, (x) => (x < 64 ? 20 : x < 128 ? 120 : 255)), x: 0, y: 0 })
    const stats = m.stats()
    expect(stats.covered).toBe(256 * 64)
    expect(stats.weak).toBe(64 * 64)
    expect(stats.soft).toBe(64 * 64)
    const conf = new Uint8Array(32 * 32)
    m.confidence(m.getTile(0, 0)!, conf)
    expect(conf[0]).toBeLessThan(WEAK_Q) // x 0..15
    expect(conf[5]).toBeLessThan(SHARP_Q) // x 80..95
    expect(conf[5]).toBeGreaterThanOrEqual(WEAK_Q)
    expect(conf[10]).toBeGreaterThanOrEqual(SHARP_Q) // x 160..175
    expect(conf[20]).toBe(0) // x 320..: empty
  })
})
