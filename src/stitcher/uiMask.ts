import { dilate, erode } from './image'

/**
 * Learns which screen pixels belong to the HUD.
 *
 * Idea: when the camera pans by `d`, world pixels obey cur(p) ≈ prev(p − d) while
 * HUD pixels obey cur(p) ≈ prev(p). Per pixel we keep a score in [-1, 1]:
 *   - pixel changed on screen                    → strong "world" vote
 *   - unchanged on screen but the motion-compensated
 *     prediction does not match                   → strong "UI" vote
 *   - unchanged and ambiguous (flat area)        → weak "UI" vote
 * Flat world regions may temporarily be classified as UI; they flip back the moment
 * any texture scrolls through them, and masking them only costs a little coverage.
 */
export class UiMaskEstimator {
  readonly w: number
  readonly h: number
  /** Number of frames with enough motion that contributed votes. */
  observations = 0
  private score: Float32Array
  private tmp: Uint8Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.score = new Float32Array(w * h)
    this.tmp = new Uint8Array(w * h)
  }

  reset(): void {
    this.score.fill(0)
    this.observations = 0
  }

  /**
   * @param cur current frame (grayscale, mask scale)
   * @param prev previous frame (grayscale, mask scale)
   * @param dx,dy integer content shift in mask-scale pixels: cur(p) ≈ prev(p − d)
   */
  observe(cur: Float32Array, prev: Float32Array, dx: number, dy: number): void {
    const { w, h, score } = this
    const CHANGED = 9
    const MARGIN = 8
    for (let y = 0; y < h; y++) {
      const py = y - dy
      const rowInside = py >= 0 && py < h
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const c = cur[i]
        const a = Math.abs(c - prev[i])
        let s = score[i]
        if (a > CHANGED) {
          s += 0.5 * (-1 - s)
        } else {
          const px = x - dx
          if (rowInside && px >= 0 && px < w) {
            const b = Math.abs(c - prev[py * w + px])
            if (b > a + MARGIN) s += 0.25 * (1 - s)
            else s += 0.08 * (1 - s)
          } else {
            s += 0.08 * (1 - s)
          }
        }
        score[i] = s
      }
    }
    this.observations++
  }

  /** Writes 1 for UI pixels, 0 otherwise. */
  computeMask(out: Uint8Array): void {
    const { w, h, score, tmp } = this
    for (let i = 0; i < w * h; i++) out[i] = score[i] > 0.5 ? 1 : 0
    // Remove isolated speckles (opening), fill small gaps (closing), then pad a little
    // so anti-aliased HUD edges and drop shadows are excluded too.
    erode(out, w, h, 1, tmp)
    dilate(out, w, h, 1, tmp)
    dilate(out, w, h, 3, tmp)
    erode(out, w, h, 2, tmp)
    dilate(out, w, h, 1, tmp)
  }
}
