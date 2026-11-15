/**
 * Minimal radix-2 complex FFT (in place) and a 2D wrapper.
 * Sizes must be powers of two. Twiddles / bit-reversal tables are cached per size.
 */

interface Plan {
  rev: Uint32Array
  cos: Float64Array
  sin: Float64Array
}

const plans = new Map<number, Plan>()

function getPlan(n: number): Plan {
  let plan = plans.get(n)
  if (plan) return plan
  if (n & (n - 1)) throw new Error(`FFT size must be a power of two, got ${n}`)
  const bits = Math.log2(n)
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const half = n >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = Math.sin((2 * Math.PI * i) / n)
  }
  plan = { rev, cos, sin }
  plans.set(n, plan)
  return plan
}

export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** In-place FFT of `n` complex values. Inverse is NOT normalised. */
export function fft1d(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const { rev, cos, sin } = getPlan(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  const sign = inverse ? 1 : -1
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t]
        const wi = sign * sin[t]
        const a = start + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

/** Row-major 2D FFT of a `w`×`h` complex image. */
export class FFT2D {
  readonly w: number
  readonly h: number
  private rowRe: Float64Array
  private rowIm: Float64Array
  private colRe: Float64Array
  private colIm: Float64Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.rowRe = new Float64Array(w)
    this.rowIm = new Float64Array(w)
    this.colRe = new Float64Array(h)
    this.colIm = new Float64Array(h)
  }

  /**
   * @param rowsNonZero optional count of leading rows that may be non-zero
   *   (rows after that are known to be zero, so their row FFTs are skipped).
   */
  transform(re: Float64Array, im: Float64Array, inverse: boolean, rowsNonZero = this.h): void {
    const { w, h, rowRe, rowIm, colRe, colIm } = this
    for (let y = 0; y < rowsNonZero; y++) {
      const o = y * w
      for (let x = 0; x < w; x++) {
        rowRe[x] = re[o + x]
        rowIm[x] = im[o + x]
      }
      fft1d(rowRe, rowIm, w, inverse)
      for (let x = 0; x < w; x++) {
        re[o + x] = rowRe[x]
        im[o + x] = rowIm[x]
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        colRe[y] = re[y * w + x]
        colIm[y] = im[y * w + x]
      }
      fft1d(colRe, colIm, h, inverse)
      for (let y = 0; y < h; y++) {
        re[y * w + x] = colRe[y]
        im[y * w + x] = colIm[y]
      }
    }
  }
}
