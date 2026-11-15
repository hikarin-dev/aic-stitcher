import { FFT2D, nextPow2 } from './fft'
import { boxSum } from './image'

export interface Spectrum {
  re: Float64Array
  im: Float64Array
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ShiftEstimate {
  /** Shift of the content of `cur` relative to `ref`, i.e. cur(p) ≈ ref(p - d). */
  dx: number
  dy: number
  /** Normalised correlation peak height (0..1). */
  peak: number
  /** Ratio between the best peak and the best peak elsewhere. */
  ratio: number
}

/**
 * Translation estimation with phase correlation on small (downscaled) grayscale images.
 * Robust to global brightness changes because the cross-power spectrum is whitened.
 */
export class PhaseCorrelator {
  readonly lw: number
  readonly lh: number
  readonly fw: number
  readonly fh: number
  private fft: FFT2D
  private winX: Float32Array
  private winY: Float32Array
  private windowRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private lowPass: Float32Array
  private lowPassSum = 0
  private corrRe: Float64Array
  private corrIm: Float64Array
  // Scratch buffers for local-mean removal
  private bufV: Float32Array
  private bufM: Float32Array
  private sumV: Float32Array
  private sumM: Float32Array
  private sumF: Float32Array
  private tmp: Float32Array

  constructor(lw: number, lh: number) {
    this.lw = lw
    this.lh = lh
    this.fw = nextPow2(lw)
    this.fh = nextPow2(lh)
    this.fft = new FFT2D(this.fw, this.fh)
    this.winX = new Float32Array(lw)
    this.winY = new Float32Array(lh)
    this.corrRe = new Float64Array(this.fw * this.fh)
    this.corrIm = new Float64Array(this.fw * this.fh)
    const n = lw * lh
    this.bufV = new Float32Array(n)
    this.bufM = new Float32Array(n)
    this.sumV = new Float32Array(n)
    this.sumM = new Float32Array(n)
    this.sumF = new Float32Array(n)
    this.tmp = new Float32Array(n)
    this.setWindowRect({ x: 0, y: 0, w: lw, h: lh })

    // Band-pass on the whitened cross-power spectrum:
    //  - a gentle Gaussian low-pass suppresses noise-dominated high frequencies;
    //  - the lowest frequencies are removed because screen-fixed shading (vignette,
    //    cloud shadow gradients, the window function itself) lives there and would
    //    otherwise create a strong false "no motion" peak.
    const { fw, fh } = this
    this.lowPass = new Float32Array(fw * fh)
    for (let v = 0; v < fh; v++) {
      const fv = (v <= fh / 2 ? v : v - fh) / fh
      for (let u = 0; u < fw; u++) {
        const fu = (u <= fw / 2 ? u : u - fw) / fw
        const f2 = fu * fu + fv * fv
        const g = Math.exp(-f2 / (2 * 0.2 * 0.2)) * (1 - Math.exp(-f2 / (2 * 0.012 * 0.012)))
        this.lowPass[v * fw + u] = g
        this.lowPassSum += g
      }
    }
  }

  createSpectrum(): Spectrum {
    const n = this.fw * this.fh
    return { re: new Float64Array(n), im: new Float64Array(n) }
  }

  /** Restrict the Hann window (and therefore the analysed area) to a sub-rectangle. */
  setWindowRect(rect: Rect): void {
    const r = this.windowRect
    if (r.x === rect.x && r.y === rect.y && r.w === rect.w && r.h === rect.h) return
    this.windowRect = { ...rect }
    this.winX.fill(0)
    this.winY.fill(0)
    for (let i = 0; i < rect.w; i++) {
      this.winX[rect.x + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / rect.w)
    }
    for (let i = 0; i < rect.h; i++) {
      this.winY[rect.y + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / rect.h)
    }
  }

  /**
   * @param img `lw`×`lh` grayscale image
   * @param valid optional `lw`×`lh` mask, 0 = ignore pixel
   *
   * The image is high-passed by subtracting a local mean computed only over valid
   * pixels (normalised convolution) and masked regions are feathered. Without this,
   * screen-fixed shading (vignette, cloud gradients) turns the static mask boundary
   * into strong static edges that pull the estimate towards "no motion".
   */
  computeSpectrum(img: Float32Array, valid: Uint8Array | null, out: Spectrum): void {
    const { lw, lh, fw, winX, winY, bufV, bufM, sumV, sumM, sumF, tmp } = this
    const n = lw * lh
    for (let i = 0; i < n; i++) {
      const m = valid && !valid[i] ? 0 : 1
      bufM[i] = m
      bufV[i] = img[i] * m
    }
    const r = Math.max(2, Math.round(Math.min(lw, lh) / 16))
    boxSum(bufV, lw, lh, r, sumV, tmp)
    boxSum(bufM, lw, lh, r, sumM, tmp)
    // Feathering weight: fraction of valid pixels in a 5×5 neighbourhood.
    boxSum(bufM, lw, lh, 2, sumF, tmp)
    const featherNorm = 1 / 25

    const { re, im } = out
    re.fill(0)
    im.fill(0)
    for (let y = 0; y < lh; y++) {
      const wy = winY[y]
      if (wy === 0) continue
      for (let x = 0; x < lw; x++) {
        const i = y * lw + x
        if (bufM[i] === 0) continue
        const localMean = sumV[i] / sumM[i]
        const feather = sumF[i] * featherNorm
        re[y * fw + x] = (img[i] - localMean) * feather * feather * wy * winX[x]
      }
    }
    this.fft.transform(re, im, false, lh)
  }

  correlate(cur: Spectrum, ref: Spectrum): ShiftEstimate {
    const { fw, fh, corrRe, corrIm, lowPass } = this
    const n = fw * fh
    for (let i = 0; i < n; i++) {
      const ar = cur.re[i]
      const ai = cur.im[i]
      const br = ref.re[i]
      const bi = ref.im[i]
      // cur * conj(ref)
      const cr = ar * br + ai * bi
      const ci = ai * br - ar * bi
      const mag = Math.sqrt(cr * cr + ci * ci) + 1e-12
      const k = lowPass[i] / mag
      corrRe[i] = cr * k
      corrIm[i] = ci * k
    }
    this.fft.transform(corrRe, corrIm, true)

    let best = -Infinity
    let bi = 0
    for (let i = 0; i < n; i++) {
      if (corrRe[i] > best) {
        best = corrRe[i]
        bi = i
      }
    }
    const px = bi % fw
    const py = (bi / fw) | 0

    // Second-best peak outside a small neighbourhood (toroidal distance).
    let second = 1e-12
    for (let y = 0; y < fh; y++) {
      let ddy = Math.abs(y - py)
      ddy = Math.min(ddy, fh - ddy)
      for (let x = 0; x < fw; x++) {
        let ddx = Math.abs(x - px)
        ddx = Math.min(ddx, fw - ddx)
        if (ddx <= 3 && ddy <= 3) continue
        const v = corrRe[y * fw + x]
        if (v > second) second = v
      }
    }

    const at = (x: number, y: number) => corrRe[((y + fh) % fh) * fw + ((x + fw) % fw)]
    const sub = (m: number, c: number, p: number) => {
      const d = m - 2 * c + p
      return d < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * d))) : 0
    }
    const ox = sub(at(px - 1, py), best, at(px + 1, py))
    const oy = sub(at(px, py - 1), best, at(px, py + 1))

    const dx = (px > fw / 2 ? px - fw : px) + ox
    const dy = (py > fh / 2 ? py - fh : py) + oy
    return { dx, dy, peak: best / this.lowPassSum, ratio: best / second }
  }
}
