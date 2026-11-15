import { describe, expect, it } from 'vitest'
import { Mosaic, TILE_SIZE, type CompositeInput } from './mosaic'

const GREY = 0xff000000 | (100 << 16) | (100 << 8) | 100

/** A W×H frame of flat grey with quality from `q`, optionally with painted rectangles. */
function frame(
  w: number,
  h: number,
  q: (x: number, y: number) => number,
  rects: Array<{ x: number; y: number; w: number; h: number; v: number }> = [],
  over: Partial<CompositeInput> = {},
): Omit<CompositeInput, 'x' | 'y'> {
  const rgba32 = new Uint32Array(w * h).fill(GREY)
  const lum = new Uint8Array(w * h).fill(100)
  const qa = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) qa[y * w + x] = q(x, y)
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        rgba32[y * w + x] = 0xff000000 | (r.v << 16) | (r.v << 8) | r.v
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
    gain: new Uint16Array([256]),
    gainW: 1,
    gainH: 1,
    gainScale: w,
    speedFactor: 1,
    confirm: true,
    ...over,
  }
}

const lumAt = (m: Mosaic, x: number, y: number) => {
  const t = m.getTile(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))!
  return t.lum[(y - t.ty * TILE_SIZE) * TILE_SIZE + (x - t.tx * TILE_SIZE)]
}

describe('Mosaic', () => {
  it('writes across tile boundaries and fills thin gaps only', () => {
    const m = new Mosaic()
    // 4px-wide vertical hole at x 498..501 (straddles tiles), and a 40px hole at 600..639.
    const hole = (x: number) => (x >= 498 && x < 502) || (x >= 600 && x < 640)
    m.composite({ ...frame(700, 20, (x) => (hole(x) ? 0 : 200)), x: 0, y: 0 })
    expect(m.tiles.size).toBe(2)
    expect(m.fillGaps(16)).toBe(4 * 20)
    expect(m.getTile(0, 0)!.q[500]).toBe(1)
    expect(m.getTile(1, 0)!.q[600 - TILE_SIZE]).toBe(0)
  })

  it('takes an animated object entirely from one frame, never half/half', () => {
    const m = new Mosaic()
    // Frame A: object (lum 200) at x 40..80, quality rising to the right.
    m.composite({ ...frame(120, 60, (x) => 50 + x, [{ x: 40, y: 20, w: 40, h: 20, v: 200 }]), x: 0, y: 0 })
    // Frame B: same object in another animation state (lum 30), quality rising to the left,
    // so per-pixel "best quality" would split the object down the middle.
    m.composite({ ...frame(120, 60, (x) => 170 - x, [{ x: 40, y: 20, w: 40, h: 20, v: 30 }]), x: 0, y: 0 })
    const values = new Set<number>()
    for (let x = 40; x < 80; x++) values.add(lumAt(m, x, 30))
    expect(values.size).toBe(1)
  })

  it('does not overwrite a confirmed object with a copy cut off by the frame edge', () => {
    const m = new Mosaic()
    const obj = [{ x: 40, y: 20, w: 40, h: 20, v: 200 }]
    // Seen twice in the same state → confirmed.
    m.composite({ ...frame(120, 60, () => 100, obj), x: 0, y: 0 })
    m.composite({ ...frame(120, 60, () => 100, obj), x: 0, y: 0 })
    // New frame shifted so the object (now in another state) touches its left edge, higher quality.
    m.composite({ ...frame(120, 60, () => 250, [{ x: 0, y: 20, w: 20, h: 20, v: 30 }]), x: 60, y: 0 })
    for (let x = 40; x < 80; x++) expect(lumAt(m, x, 30)).toBe(200)
  })

  it('keeps an unconfirmed (animated) object over a worse copy cut off by the frame edge', () => {
    const m = new Mosaic()
    m.composite({ ...frame(120, 60, () => 200, [{ x: 40, y: 20, w: 40, h: 20, v: 200 }]), x: 0, y: 0 })
    // Real frames lose quality towards their edges (distance transform).
    const edgeQ = (x: number) => Math.min(250, 20 + 4 * x)
    m.composite({ ...frame(120, 60, edgeQ, [{ x: 0, y: 20, w: 20, h: 20, v: 30 }]), x: 60, y: 0 })
    for (let x = 40; x < 80; x++) expect(lumAt(m, x, 30)).toBe(200)
  })

  it('replaces unconfirmed content at a frame edge (leaked HUD text) with a better view', () => {
    const m = new Mosaic()
    // HUD text that slipped past the mask, stored once with mediocre quality.
    m.composite({ ...frame(120, 60, () => 100, [{ x: 40, y: 20, w: 40, h: 20, v: 230 }]), x: 0, y: 0 })
    // A clean, sharp view of the same world area, which here touches the frame edge.
    m.composite({ ...frame(120, 60, () => 250), x: 60, y: 0 })
    for (let x = 60; x < 80; x++) expect(lumAt(m, x, 30)).toBe(100)
  })

  it('replaces one-off content such as a cursor, but keeps confirmed content', () => {
    const m = new Mosaic()
    // Fast frame (drag) with a cursor: not confirmed.
    m.composite({ ...frame(120, 60, () => 200, [{ x: 50, y: 20, w: 12, h: 16, v: 250 }], { speedFactor: 0.5, confirm: false }), x: 0, y: 0 })
    expect(lumAt(m, 55, 28)).toBe(250)
    // Slow frame without the cursor: replaces it.
    m.composite({ ...frame(120, 60, () => 200), x: 0, y: 0 })
    expect(lumAt(m, 55, 28)).toBe(100)

    // Confirmed content (seen by several slow frames) survives a single disagreeing frame.
    const c = new Mosaic()
    for (let i = 0; i < 3; i++) c.composite({ ...frame(120, 60, () => 200, [{ x: 50, y: 20, w: 12, h: 16, v: 250 }]), x: 0, y: 0 })
    c.composite({ ...frame(120, 60, () => 200), x: 0, y: 0 })
    expect(lumAt(c, 55, 28)).toBe(250)
  })
})
