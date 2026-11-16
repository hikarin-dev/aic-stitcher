import { describe, expect, it } from 'vitest'
import { MinCut } from './mincut'
import { mulberry32 } from './synthetic'

/** A random problem on a w×h grid; returns everything needed to price a labelling by hand. */
function randomGrid(w: number, h: number, seed: number) {
  const rand = mulberry32(seed)
  const n = w * h
  const s = Array.from({ length: n }, () => (rand() < 0.5 ? Math.floor(rand() * 20) : 0))
  const t = Array.from({ length: n }, () => (rand() < 0.5 ? Math.floor(rand() * 20) : 0))
  const links: Array<[number, number, 0 | 2, number]> = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // Some links are missing: the overlap of two pictures is rarely a full rectangle.
      if (x + 1 < w && rand() < 0.85) links.push([p, p + 1, 0, Math.floor(rand() * 12)])
      if (y + 1 < h && rand() < 0.85) links.push([p, p + w, 2, Math.floor(rand() * 12)])
    }
  }
  return { n, s, t, links }
}

/** Cost of a labelling (bit p set = node p on the source side). */
function cost(g: ReturnType<typeof randomGrid>, labels: number): number {
  let c = 0
  for (let p = 0; p < g.n; p++) c += (labels >> p) & 1 ? g.t[p] : g.s[p]
  for (const [p, q, , w] of g.links) if (((labels >> p) & 1) !== ((labels >> q) & 1)) c += w
  return c
}

describe('MinCut', () => {
  it('finds the cheapest labelling on small random grids (checked against every labelling)', () => {
    const cut = new MinCut()
    for (let seed = 1; seed <= 60; seed++) {
      const g = randomGrid(4, 3, seed)
      cut.reset(g.n)
      for (let p = 0; p < g.n; p++) {
        cut.capS[p] = g.s[p]
        cut.capT[p] = g.t[p]
      }
      for (const [p, q, d, w] of g.links) cut.link(p, q, d, w)
      const value = cut.solve()
      let best = Infinity
      for (let labels = 0; labels < 1 << g.n; labels++) best = Math.min(best, cost(g, labels))
      let labels = 0
      for (let p = 0; p < g.n; p++) if (cut.onSourceSide(p)) labels |= 1 << p
      expect(value).toBe(best)
      expect(cost(g, labels)).toBe(best)
    }
  })

  it('goes round an obstacle instead of through it', () => {
    // A 9×5 band, source above, sink below. Crossing a link costs 1, except in the
    // middle row where a "pipe" (cost 50) runs from the left edge to column 6.
    const w = 9
    const h = 5
    const cut = new MinCut()
    cut.reset(w * h)
    const pipe = (x: number, y: number) => y === 2 && x <= 6
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (y === 0) cut.capS[p] = 1000
        if (y === h - 1) cut.capT[p] = 1000
        // A link is as expensive as the dearer of the two cells it separates... except
        // that leaving the pipe is free: the cut may hug it, not slice it.
        if (x + 1 < w) cut.link(p, p + 1, 0, pipe(x, y) && pipe(x + 1, y) ? 50 : 1)
        if (y + 1 < h) cut.link(p, p + w, 2, 1)
      }
    }
    expect(cut.solve()).toBe(w) // one cheap link per column
    // No two neighbouring pipe cells are on different sides.
    for (let x = 0; x < 6; x++) {
      expect(cut.onSourceSide(2 * w + x)).toBe(cut.onSourceSide(2 * w + x + 1))
    }
  })

  it('handles a problem the size of a real overlap quickly', () => {
    const w = 480
    const h = 60
    const rand = mulberry32(5)
    const cut = new MinCut()
    cut.reset(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (y === 0) cut.capS[p] = 100000
        if (y === h - 1) cut.capT[p] = 100000
        // Mostly agreeing ground with blobs of disagreement, like a real overlap.
        const busy = Math.sin(x / 7) * Math.cos(y / 5) > 0.3
        if (x + 1 < w) cut.link(p, p + 1, 0, busy ? 200 + Math.floor(rand() * 400) : 4)
        if (y + 1 < h) cut.link(p, p + w, 2, busy ? 200 + Math.floor(rand() * 400) : 4)
      }
    }
    const t0 = performance.now()
    const value = cut.solve()
    const ms = performance.now() - t0
    console.log(`mincut ${w}x${h}: value ${value} in ${ms.toFixed(1)} ms`)
    expect(value).toBeGreaterThan(0)
    expect(ms).toBeLessThan(2000)
  })
})
