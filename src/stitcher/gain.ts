/**
 * Lighting correction. Clouds drifting over the map change brightness globally and
 * locally, so we estimate a smooth multiplicative gain field (a coarse grid of cells,
 * bilinearly interpolated) that maps the current frame onto the mosaic's brightness.
 */

export interface GainInput {
  lum: Uint8Array
  q: Uint8Array
  width: number
  height: number
  region: Uint8Array
  regionQ: Uint8Array
  regionW: number
  /** Region coordinates of frame pixel (0, 0). */
  offX: number
  offY: number
  /**
   * Only compare against map pixels stored with at least this quality. Pixels written
   * near a frame edge carry that edge's vignette / shading; normalising against them
   * makes the whole map drift darker (or brighter) as you pan.
   */
  minMapQ: number
}

export class GainEstimator {
  readonly cellsX: number
  readonly cellsY: number
  private sumF: Float64Array
  private sumM: Float64Array
  private cnt: Float64Array
  private cellGain: Float64Array

  constructor(cellsX = 8, cellsY = 5) {
    this.cellsX = cellsX
    this.cellsY = cellsY
    const n = cellsX * cellsY
    this.sumF = new Float64Array(n)
    this.sumM = new Float64Array(n)
    this.cnt = new Float64Array(n)
    this.cellGain = new Float64Array(n).fill(1)
  }

  /**
   * Estimates per-cell gains. Returns the global gain, or null when the overlap with
   * the mosaic is too small to estimate anything (caller should reuse the last gain).
   */
  estimate(input: GainInput, stride = 6): number | null {
    const { lum, q, width, height, region, regionQ, regionW, offX, offY, minMapQ } = input
    const { cellsX, cellsY, sumF, sumM, cnt, cellGain } = this

    const sample = (pass: (f: number, m: number, x: number, y: number) => void) => {
      for (let y = 0; y < height; y += stride) {
        const rrow = (y + offY) * regionW + offX
        for (let x = (y / stride) & 1 ? stride >> 1 : 0; x < width; x += stride) {
          const i = y * width + x
          if (q[i] === 0) continue
          const j = rrow + x
          if (regionQ[j] < minMapQ) continue
          const f = lum[i]
          const m = region[j]
          if (f < 12 || m < 12 || f > 245 || m > 245) continue
          pass(f, m, x, y)
        }
      }
    }

    // Pass 1: global ratio.
    let sf = 0
    let sm = 0
    let n = 0
    sample((f, m) => {
      sf += f
      sm += m
      n++
    })
    if (n < 300) return null
    const g0 = sm / sf

    // Pass 2: per cell, rejecting outliers (animated objects, misaligned edges).
    sumF.fill(0)
    sumM.fill(0)
    cnt.fill(0)
    const lo = g0 * 0.8
    const hi = g0 * 1.25
    let gf = 0
    let gm = 0
    sample((f, m, x, y) => {
      const r = m / f
      if (r < lo || r > hi) return
      const c = Math.min(cellsY - 1, ((y * cellsY) / height) | 0) * cellsX + Math.min(cellsX - 1, ((x * cellsX) / width) | 0)
      sumF[c] += f
      sumM[c] += m
      cnt[c]++
      gf += f
      gm += m
    })
    const g = gf > 0 ? gm / gf : g0
    for (let c = 0; c < cellsX * cellsY; c++) {
      const w = cnt[c] / (cnt[c] + 40)
      const local = sumF[c] > 0 ? sumM[c] / sumF[c] : g
      cellGain[c] = clampGain(w * local + (1 - w) * g)
    }
    return clampGain(g)
  }

  /**
   * Applies only `strength` of the estimated correction, clamped to [lo, hi]. Each
   * frame is normalised against a map built from earlier normalised frames, so a full
   * correction lets a single bad estimate lock in and compound (the map runs away
   * brighter or darker). A partial correction keeps pulling the map back towards the
   * game's actual brightness.
   * @returns the damped global gain
   */
  damp(global: number, strength: number, lo: number, hi: number): number {
    const f = (g: number) => Math.max(lo, Math.min(hi, 1 + strength * (g - 1)))
    for (let c = 0; c < this.cellGain.length; c++) this.cellGain[c] = f(this.cellGain[c])
    return f(global)
  }

  /** Fills every cell with the same gain. */
  setUniform(g: number): void {
    this.cellGain.fill(clampGain(g))
  }

  /**
   * Renders the gain field into a `gw`×`gh` fixed-point (256 = 1.0) image where each
   * gain pixel covers `scale`×`scale` frame pixels.
   */
  render(out: Uint16Array, gw: number, gh: number, scale: number, frameW: number, frameH: number): void {
    const { cellsX, cellsY, cellGain } = this
    const cw = frameW / cellsX
    const ch = frameH / cellsY
    for (let y = 0; y < gh; y++) {
      const v = Math.max(0, Math.min(cellsY - 1, ((y + 0.5) * scale) / ch - 0.5))
      const y0 = Math.floor(v)
      const y1 = Math.min(cellsY - 1, y0 + 1)
      const fy = v - y0
      for (let x = 0; x < gw; x++) {
        const u = Math.max(0, Math.min(cellsX - 1, ((x + 0.5) * scale) / cw - 0.5))
        const x0 = Math.floor(u)
        const x1 = Math.min(cellsX - 1, x0 + 1)
        const fx = u - x0
        const a = cellGain[y0 * cellsX + x0] * (1 - fx) + cellGain[y0 * cellsX + x1] * fx
        const b = cellGain[y1 * cellsX + x0] * (1 - fx) + cellGain[y1 * cellsX + x1] * fx
        out[y * gw + x] = Math.round((a * (1 - fy) + b * fy) * 256)
      }
    }
  }
}

function clampGain(g: number): number {
  return Math.max(0.4, Math.min(2.5, g))
}
