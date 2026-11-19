/**
 * Full-resolution alignment refinement against the mosaic.
 *
 * A sparse set of textured frame pixels is compared against the mosaic for every
 * integer offset within a search radius using zero-mean normalised cross-correlation
 * (ZNCC), which is invariant to brightness gain/offset (lighting changes).
 */

import { sampleGrid } from './image'
import { NORM_FLOOR, NORM_LEVEL } from './mosaic'

export const BLOCKS_X = 4
export const BLOCKS_Y = 3
const NB = BLOCKS_X * BLOCKS_Y

export class SampleSet {
  x = new Int32Array(0)
  y = new Int32Array(0)
  v = new Float32Array(0)
  /** Linear index into the current search region (depends on region width). */
  idx = new Int32Array(0)
  /** Screen block (BLOCKS_X × BLOCKS_Y grid) each sample belongs to. */
  block = new Uint8Array(0)
  count = 0

  ensure(n: number): void {
    if (this.x.length >= n) return
    this.x = new Int32Array(n)
    this.y = new Int32Array(n)
    this.v = new Float32Array(n)
    this.idx = new Int32Array(n)
    this.block = new Uint8Array(n)
  }
}

/** A frame's local brightness on a coarse grid (see `CompositeInput.shade`). */
export interface ShadeField {
  shade: Float32Array
  w: number
  h: number
  scale: number
}

/**
 * Picks textured, valid pixels on a regular grid. Sample values are lighting-normalised
 * the same way the mosaic stores its luma (surroundings → NORM_LEVEL), so the match is
 * blind to cloud shadows and vignettes.
 */
export function selectSamples(
  lum: Uint8Array,
  q: Uint8Array,
  w: number,
  h: number,
  stride: number,
  minGradient: number,
  out: SampleSet,
  field: ShadeField,
): void {
  out.ensure(Math.ceil(w / stride) * Math.ceil(h / stride))
  let n = 0
  for (let y = 1; y < h - 1; y += stride) {
    for (let x = 1 + ((y / stride) & 1) * (stride >> 1); x < w - 1; x += stride) {
      const i = y * w + x
      if (q[i] === 0) continue
      const g = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w])
      if (g < minGradient) continue
      const shade = sampleGrid(field.shade, field.w, field.h, field.scale, x, y)
      out.x[n] = x
      out.y[n] = y
      out.v[n] = Math.min(255, (lum[i] * NORM_LEVEL) / Math.max(NORM_FLOOR, shade))
      out.block[n] = (((y * BLOCKS_Y) / h) | 0) * BLOCKS_X + (((x * BLOCKS_X) / w) | 0)
      n++
    }
  }
  out.count = n
}

export interface RefineResult {
  dx: number
  dy: number
  score: number
  /** Number of samples that overlapped covered mosaic pixels at the best offset. */
  overlap: number
}

/**
 * @param region mosaic luma for the frame rectangle grown by `radius` on every side
 * @param regionQ matching mosaic quality (0 = uncovered)
 * @param rw region width (= frame width + 2·radius)
 * @returns best offset, or null when there is not enough overlap to decide
 */
export function refineOffset(
  samples: SampleSet,
  region: Uint8Array,
  regionQ: Uint8Array,
  rw: number,
  radius: number,
  coarseSamples = 2500,
): RefineResult | null {
  const { count, x, y, idx } = samples
  if (count < 50) return null
  for (let i = 0; i < count; i++) idx[i] = y[i] * rw + x[i]

  const minOverlap = (n: number) => Math.max(40, n * 0.2)
  const step1 = Math.max(1, Math.floor(count / coarseSamples))
  const n1 = Math.ceil(count / step1)

  let best = -Infinity
  let bx = 0
  let by = 0
  let bestOverlap = 0
  const side = 2 * radius + 1
  const step0 = step1 * SCOUT_THIN
  const n0 = Math.ceil(count / step0)
  if (side * side > 4 * SCOUT_KEEP * (2 * SCOUT_REACH + 1) ** 2 && n0 >= 200) {
    // Most of the window is nowhere near the answer. A first look with a fraction of
    // the samples picks out the few places that deserve a proper one.
    if (visited.length < side * side) visited = new Uint8Array(side * side)
    visited.fill(0, 0, side * side)
    scoutScore.fill(-Infinity)
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const r = zncc(samples, step0, region, regionQ, (oy + radius) * rw + ox + radius)
        if (r.n < minOverlap(n0)) continue
        // Keep the best few, best first.
        let k = SCOUT_KEEP
        while (k > 0 && r.score > scoutScore[k - 1]) k--
        if (k === SCOUT_KEEP) continue
        for (let m = SCOUT_KEEP - 1; m > k; m--) {
          scoutScore[m] = scoutScore[m - 1]
          scoutAt[m] = scoutAt[m - 1]
        }
        scoutScore[k] = r.score
        scoutAt[k] = (oy + radius) * side + ox + radius
      }
    }
    for (let k = 0; k < SCOUT_KEEP && scoutScore[k] > -Infinity; k++) {
      const cy = ((scoutAt[k] / side) | 0) - radius
      const cx = (scoutAt[k] % side) - radius
      for (let oy = Math.max(-radius, cy - SCOUT_REACH); oy <= Math.min(radius, cy + SCOUT_REACH); oy++) {
        for (let ox = Math.max(-radius, cx - SCOUT_REACH); ox <= Math.min(radius, cx + SCOUT_REACH); ox++) {
          const at = (oy + radius) * side + ox + radius
          if (visited[at]) continue
          visited[at] = 1
          const r = zncc(samples, step1, region, regionQ, (oy + radius) * rw + ox + radius)
          if (r.n < minOverlap(n1)) continue
          if (r.score > best) {
            best = r.score
            bx = ox
            by = oy
            bestOverlap = r.n
          }
        }
      }
    }
  } else {
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const r = zncc(samples, step1, region, regionQ, (oy + radius) * rw + ox + radius)
        if (r.n < minOverlap(n1)) continue
        if (r.score > best) {
          best = r.score
          bx = ox
          by = oy
          bestOverlap = r.n
        }
      }
    }
  }
  if (best === -Infinity) return null

  if (step1 > 1) {
    // Re-evaluate the neighbourhood of the coarse winner with every sample.
    const cx = bx
    const cy = by
    best = -Infinity
    for (let oy = Math.max(-radius, cy - 1); oy <= Math.min(radius, cy + 1); oy++) {
      for (let ox = Math.max(-radius, cx - 1); ox <= Math.min(radius, cx + 1); ox++) {
        const r = zncc(samples, 1, region, regionQ, (oy + radius) * rw + ox + radius)
        if (r.n < minOverlap(count)) continue
        if (r.score > best) {
          best = r.score
          bx = ox
          by = oy
          bestOverlap = r.n
        }
      }
    }
    if (best === -Infinity) return null
  }
  return { dx: bx, dy: by, score: best, overlap: bestOverlap }
}

const acc = new Float64Array(NB * 6)

/** The first look at the search window uses every this-many-th of the samples the proper look uses... */
const SCOUT_THIN = 4
/** ...and this many of its best offsets get the proper look, each with the offsets up to this far around it. */
const SCOUT_KEEP = 4
const SCOUT_REACH = 2
const scoutScore = new Float64Array(SCOUT_KEEP)
const scoutAt = new Int32Array(SCOUT_KEEP)
let visited = new Uint8Array(0)

/**
 * ZNCC computed separately in each screen block, then averaged (weighted by sample
 * count). Each block gets its own gain/offset, so smooth lighting differences across
 * the screen (vignette, cloud shadow edges) don't drag the score down.
 */
function zncc(
  samples: SampleSet,
  step: number,
  region: Uint8Array,
  regionQ: Uint8Array,
  base: number,
): { score: number; n: number } {
  const { count, v, idx, block } = samples
  acc.fill(0)
  for (let i = 0; i < count; i += step) {
    const j = base + idx[i]
    if (regionQ[j] === 0) continue
    const f = v[i]
    const m = region[j]
    const o = block[i] * 6
    acc[o]++
    acc[o + 1] += f
    acc[o + 2] += m
    acc[o + 3] += f * f
    acc[o + 4] += m * m
    acc[o + 5] += f * m
  }
  let total = 0
  let weighted = 0
  let weight = 0
  for (let b = 0; b < NB; b++) {
    const o = b * 6
    const n = acc[o]
    total += n
    if (n < 12) continue
    const vf = acc[o + 3] - (acc[o + 1] * acc[o + 1]) / n
    const vm = acc[o + 4] - (acc[o + 2] * acc[o + 2]) / n
    const den = Math.sqrt(vf * vm)
    if (den < 1e-6) continue
    const cov = acc[o + 5] - (acc[o + 1] * acc[o + 2]) / n
    weighted += (cov / den) * n
    weight += n
  }
  return { score: weight > 0 ? weighted / weight : -1, n: total }
}
