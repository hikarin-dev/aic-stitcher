/** Small, allocation-free image helpers operating on typed arrays. */

export type Pixels = Uint8Array | Uint8ClampedArray

/** Rec.601-ish integer luma. */
export function rgbaToLuma(rgba: Pixels, out: Uint8Array, count: number): void {
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29 + 128) >> 8
  }
}

/** The same from little-endian RGBA words: one read per pixel instead of three. */
export function rgba32ToLuma(rgba32: Uint32Array, out: Uint8Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const p = rgba32[i]
    out[i] = ((p & 0xff) * 77 + ((p >>> 8) & 0xff) * 150 + ((p >>> 16) & 0xff) * 29 + 128) >> 8
  }
}

/**
 * Box-filter downscale by an integer factor `s`. Output is `floor(w/s)`×`floor(h/s)`.
 * (Separate from the Float32 variant on purpose: one function fed two array types
 * becomes polymorphic in V8 and runs several times slower.)
 */
let boxRow = new Int32Array(0)

export function downscaleBox(src: Uint8Array, w: number, s: number, out: Float32Array, ow: number, oh: number): void {
  const inv = 1 / (s * s)
  if (boxRow.length < ow) boxRow = new Int32Array(ow)
  const sum = boxRow
  for (let oy = 0; oy < oh; oy++) {
    sum.fill(0, 0, ow)
    for (let sy = 0; sy < s; sy++) {
      let p = (oy * s + sy) * w
      // (The common factors spelled out: this runs over every pixel of every frame.)
      if (s === 3) {
        for (let ox = 0; ox < ow; ox++, p += 3) sum[ox] += src[p] + src[p + 1] + src[p + 2]
      } else if (s === 2) {
        for (let ox = 0; ox < ow; ox++, p += 2) sum[ox] += src[p] + src[p + 1]
      } else if (s === 1) {
        for (let ox = 0; ox < ow; ox++) sum[ox] += src[p + ox]
      } else {
        for (let ox = 0; ox < ow; ox++) {
          let acc = 0
          for (let sx = 0; sx < s; sx++) acc += src[p++]
          sum[ox] += acc
        }
      }
    }
    const orow = oy * ow
    for (let ox = 0; ox < ow; ox++) out[orow + ox] = sum[ox] * inv
  }
}

/** Float32 input variant of {@link downscaleBox}. */
export function downscaleBoxF32(
  src: Float32Array,
  w: number,
  s: number,
  out: Float32Array,
  ow: number,
  oh: number,
): void {
  const inv = 1 / (s * s)
  out.fill(0)
  for (let oy = 0; oy < oh; oy++) {
    const orow = oy * ow
    for (let sy = 0; sy < s; sy++) {
      const srow = (oy * s + sy) * w
      for (let ox = 0; ox < ow; ox++) {
        let acc = 0
        const base = srow + ox * s
        for (let sx = 0; sx < s; sx++) acc += src[base + sx]
        out[orow + ox] += acc
      }
    }
    for (let ox = 0; ox < ow; ox++) out[orow + ox] *= inv
  }
}

/** Square dilation (value 1 spreads) with radius `r`, separable. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number, tmp: Uint8Array): void {
  morph(mask, w, h, r, tmp, 1)
}

/** Square erosion (value 0 spreads) with radius `r`, separable. */
export function erode(mask: Uint8Array, w: number, h: number, r: number, tmp: Uint8Array): void {
  morph(mask, w, h, r, tmp, 0)
}

function morph(mask: Uint8Array, w: number, h: number, r: number, tmp: Uint8Array, spread: 0 | 1): void {
  if (r <= 0) return
  // Horizontal pass: mask -> tmp
  for (let y = 0; y < h; y++) {
    const o = y * w
    let count = 0 // number of `spread` pixels within window
    for (let x = 0; x < Math.min(r, w); x++) if (mask[o + x] === spread) count++
    for (let x = 0; x < w; x++) {
      const add = x + r
      if (add < w && mask[o + add] === spread) count++
      const rem = x - r - 1
      if (rem >= 0 && mask[o + rem] === spread) count--
      tmp[o + x] = count > 0 ? spread : 1 - spread
    }
  }
  // Vertical pass: tmp -> mask
  for (let x = 0; x < w; x++) {
    let count = 0
    for (let y = 0; y < Math.min(r, h); y++) if (tmp[y * w + x] === spread) count++
    for (let y = 0; y < h; y++) {
      const add = y + r
      if (add < h && tmp[add * w + x] === spread) count++
      const rem = y - r - 1
      if (rem >= 0 && tmp[rem * w + x] === spread) count--
      mask[y * w + x] = count > 0 ? spread : 1 - spread
    }
  }
}

/**
 * Chamfer (3-4) distance transform. `valid` 0 pixels and everything outside the
 * image are sources. Result is in units of 1/3 pixel.
 */
export function distanceTransform(valid: Uint8Array, w: number, h: number, out: Uint16Array): void {
  const INF = 65000
  // Forward pass. Out-of-image neighbours count as distance 0.
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      if (!valid[i]) {
        out[i] = 0
        continue
      }
      let d = INF
      let n = x > 0 ? out[i - 1] + 3 : 3
      if (n < d) d = n
      if (y > 0) {
        n = out[i - w] + 3
        if (n < d) d = n
        n = x > 0 ? out[i - w - 1] + 4 : 4
        if (n < d) d = n
        n = x < w - 1 ? out[i - w + 1] + 4 : 4
        if (n < d) d = n
      } else if (3 < d) d = 3
      out[i] = d
    }
  }
  // Backward pass.
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x
      let d = out[i]
      if (d === 0) continue
      let n = x < w - 1 ? out[i + 1] + 3 : 3
      if (n < d) d = n
      if (y < h - 1) {
        n = out[i + w] + 3
        if (n < d) d = n
        n = x < w - 1 ? out[i + w + 1] + 4 : 4
        if (n < d) d = n
        n = x > 0 ? out[i + w - 1] + 4 : 4
        if (n < d) d = n
      } else if (3 < d) d = 3
      out[i] = d
    }
  }
}

/**
 * Bilinear sample of a coarse grid (`gw`×`gh`, each cell covering `scale`² pixels) at
 * the centre of pixel (x, y). Clamps at the borders.
 */
export function sampleGrid(grid: Float32Array, gw: number, gh: number, scale: number, x: number, y: number): number {
  const u = Math.max(0, Math.min(gw - 1, (x + 0.5) / scale - 0.5))
  const v = Math.max(0, Math.min(gh - 1, (y + 0.5) / scale - 0.5))
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const x1 = Math.min(gw - 1, x0 + 1)
  const y1 = Math.min(gh - 1, y0 + 1)
  const fx = u - x0
  const fy = v - y0
  const a = grid[y0 * gw + x0] * (1 - fx) + grid[y0 * gw + x1] * fx
  const b = grid[y1 * gw + x0] * (1 - fx) + grid[y1 * gw + x1] * fx
  return a * (1 - fy) + b * fy
}

/**
 * Separable box blur (sum, not average) with radius `r`; samples outside the image
 * are treated as 0. Use with a blurred validity mask for normalised convolution.
 */
export function boxSum(src: Float32Array, w: number, h: number, r: number, out: Float32Array, tmp: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const o = y * w
    let acc = 0
    for (let x = 0; x < Math.min(r, w); x++) acc += src[o + x]
    for (let x = 0; x < w; x++) {
      if (x + r < w) acc += src[o + x + r]
      if (x - r - 1 >= 0) acc -= src[o + x - r - 1]
      tmp[o + x] = acc
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = 0; y < Math.min(r, h); y++) acc += tmp[y * w + x]
    for (let y = 0; y < h; y++) {
      if (y + r < h) acc += tmp[(y + r) * w + x]
      if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * w + x]
      out[y * w + x] = acc
    }
  }
}
