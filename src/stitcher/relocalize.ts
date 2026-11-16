/**
 * Global relocalization: find where the current frame is on the whole map, ignoring
 * where we last were. Used when local tracking fails (fast mouse drags, menus, jumps).
 *
 * Works on 1/THUMB_SCALE thumbnails: every placement of the frame thumbnail over the
 * (padded) map thumbnail is scored with ZNCC on textured sample points, and the best
 * few distinct placements are returned. The caller verifies them at full resolution.
 */
import { downscaleBox } from './image'
import { THUMB_SCALE, type Mosaic } from './mosaic'

export interface RelocCandidate {
  /** World position of the frame's top-left corner. */
  x: number
  y: number
  score: number
}

export class Relocalizer {
  private frame = new Float32Array(0)
  private sx = new Int32Array(0)
  private sy = new Int32Array(0)
  private sv = new Float32Array(0)

  /**
   * @param lum full-resolution frame luma
   * @param q frame quality map (0 = HUD / cropped)
   */
  findCandidates(
    mosaic: Mosaic,
    lum: Uint8Array,
    q: Uint8Array,
    w: number,
    h: number,
    maxCandidates = 6,
    /** Smallest share of the frame that must lie on the map. */
    minOverlap = 0.4,
  ): RelocCandidate[] {
    const S = THUMB_SCALE
    const fw = Math.floor(w / S)
    const fh = Math.floor(h / S)
    if (fw < 4 || fh < 4) return []
    if (this.frame.length < fw * fh) {
      this.frame = new Float32Array(fw * fh)
      this.sx = new Int32Array(fw * fh)
      this.sy = new Int32Array(fw * fh)
      this.sv = new Float32Array(fw * fh)
    }
    downscaleBox(lum, w, S, this.frame, fw, fh)

    // A frame may hang off the map by all but `minOverlap` of itself in each direction.
    const padX = Math.ceil(fw * (1 - minOverlap))
    const padY = Math.ceil(fh * (1 - minOverlap))
    const map = mosaic.thumbMap(padX, padY)
    if (!map) return []

    // Textured, valid sample points of the frame thumbnail.
    const f = this.frame
    let n = 0
    for (let y = 1; y < fh - 1; y++) {
      for (let x = 1; x < fw - 1; x++) {
        const cx = x * S + (S >> 1)
        const cy = y * S + (S >> 1)
        if (q[cy * w + cx] === 0) continue
        const i = y * fw + x
        const grad = Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + fw] - f[i - fw])
        if (grad < 3) continue
        this.sx[n] = x
        this.sy[n] = y
        this.sv[n] = f[i]
        n++
      }
    }
    if (n < 20) return []
    const minSamples = Math.max(20, n * (minOverlap - 0.05))

    const { lum: ml, ok, w: mw, h: mh } = map
    const best: RelocCandidate[] = []
    const { sx, sy, sv } = this
    for (let oy = 0; oy <= mh - fh; oy++) {
      for (let ox = 0; ox <= mw - fw; ox++) {
        let c = 0
        let s1 = 0
        let s2 = 0
        let s11 = 0
        let s22 = 0
        let s12 = 0
        for (let k = 0; k < n; k++) {
          const j = (oy + sy[k]) * mw + ox + sx[k]
          if (!ok[j]) continue
          const a = sv[k]
          const b = ml[j]
          c++
          s1 += a
          s2 += b
          s11 += a * a
          s22 += b * b
          s12 += a * b
        }
        if (c < minSamples) continue
        const den = Math.sqrt((s11 - (s1 * s1) / c) * (s22 - (s2 * s2) / c))
        if (den < 1e-6) continue
        // Mild preference for larger overlap so tiny edge overlaps don't win by luck.
        const score = ((s12 - (s1 * s2) / c) / den) * Math.min(1, 0.7 + (0.3 * c) / n)
        insertCandidate(best, { x: map.x0 + ox * S, y: map.y0 + oy * S, score }, maxCandidates, S * 3)
      }
    }
    return best
  }
}

/** Keeps the top `max` candidates, suppressing ones closer than `minDist` to a better one. */
function insertCandidate(list: RelocCandidate[], c: RelocCandidate, max: number, minDist: number): void {
  if (list.length === max && c.score <= list[list.length - 1].score) return
  for (let i = 0; i < list.length; i++) {
    const o = list[i]
    if (Math.abs(o.x - c.x) < minDist && Math.abs(o.y - c.y) < minDist) {
      if (o.score >= c.score) return
      list.splice(i, 1)
      break
    }
  }
  let i = list.length
  while (i > 0 && list[i - 1].score < c.score) i--
  list.splice(i, 0, c)
  if (list.length > max) list.pop()
}
