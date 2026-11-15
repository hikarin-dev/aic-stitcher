export const TILE_SHIFT = 9
export const TILE_SIZE = 1 << TILE_SHIFT // 512
const TILE_MASK = TILE_SIZE - 1
const TILE_PIXELS = TILE_SIZE * TILE_SIZE
/** Downscale factor of the thumbnail map used for global relocalization. */
export const THUMB_SCALE = 32
const THUMB_SIZE = TILE_SIZE / THUMB_SCALE

export interface Tile {
  tx: number
  ty: number
  /** Straight RGBA, alpha 255 where covered. */
  rgba: Uint8ClampedArray<ArrayBuffer>
  /** 32-bit view of `rgba` (little-endian ABGR words). */
  rgba32: Uint32Array
  /** Luma of the stored (lighting-corrected) colour. */
  lum: Uint8ClampedArray
  /** Quality of the stored pixel, 0 = empty. Higher = captured further from frame/HUD edges. */
  q: Uint8Array
  /**
   * How many frames agreed with the stored pixel (1 = seen once). Content confirmed
   * by several frames is hard to replace; one-off content (a cursor, a transient
   * animation frame) is replaced as soon as another frame disagrees.
   */
  n: Uint8Array
  /** Mean luma per THUMB_SCALE² block, for global relocalization. */
  thumb: Float32Array
  /** 1 where the thumbnail block is mostly covered. */
  thumbOk: Uint8Array
}

/** Whole-map thumbnail, padded so a frame can hang off any edge. */
export interface ThumbMap {
  lum: Float32Array
  ok: Uint8Array
  w: number
  h: number
  /** World coordinates of thumbnail pixel (0, 0). */
  x0: number
  y0: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number // exclusive
  maxY: number // exclusive
}

/** Everything needed to write one frame into the mosaic. */
export interface CompositeInput {
  /** Frame pixels as little-endian RGBA words. */
  rgba32: Uint32Array
  lum: Uint8Array
  q: Uint8Array
  width: number
  height: number
  /** World position of the frame's top-left pixel. */
  x: number
  y: number
  /** Gain image (fixed point, 256 = 1.0) of size gainW×gainH covering the frame. */
  gain: Uint16Array
  gainW: number
  gainH: number
  /** Downscale factor between frame and gain image. */
  gainScale: number
  /** 0..1 multiplier on frame quality: fast-moving (blurry, compressed) frames get less. */
  speedFactor: number
  /** Whether agreement from this frame counts as confirmation (false for fast frames). */
  confirm: boolean
}

/** Luma difference above which frame and map disagree (animation, cursor, laser...). */
const CONFLICT_DIFF = 22
/** Conflict analysis block size in pixels (power of two). */
const BLOCK_SHIFT = 2
const BLOCK = 1 << BLOCK_SHIFT
/** Area over which brightness offsets are removed before comparing content (power of two). */
const LIGHT_SHIFT = 4
const LIGHT_BLOCK = 1 << LIGHT_SHIFT
/** Conflict blobs bigger than this fraction of the frame aren't objects: decide per pixel. */
const MAX_BLOB_FRACTION = 0.1
// Pixel classes used by composite().
const SKIP = 0
const NEW = 1
const AGREE = 2
const CONFLICT = 3

const key = (tx: number, ty: number) => (tx + 32768) * 65536 + (ty + 32768)

export class Mosaic {
  readonly tiles = new Map<number, Tile>()
  /** Tiles modified since the last `takeDirty()`. */
  private dirty = new Set<number>()
  /** Tiles whose thumbnail needs recomputing. */
  private thumbDirty = new Set<number>()
  private gainCol = new Int32Array(0)

  get isEmpty(): boolean {
    return this.tiles.size === 0
  }

  clear(): void {
    this.tiles.clear()
    this.dirty.clear()
    this.thumbDirty.clear()
  }

  getTile(tx: number, ty: number): Tile | undefined {
    return this.tiles.get(key(tx, ty))
  }

  private createTile(tx: number, ty: number): Tile {
    const rgba = new Uint8ClampedArray(TILE_PIXELS * 4)
    const tile: Tile = {
      tx,
      ty,
      rgba,
      rgba32: new Uint32Array(rgba.buffer),
      lum: new Uint8ClampedArray(TILE_PIXELS),
      q: new Uint8Array(TILE_PIXELS),
      n: new Uint8Array(TILE_PIXELS),
      thumb: new Float32Array(THUMB_SIZE * THUMB_SIZE),
      thumbOk: new Uint8Array(THUMB_SIZE * THUMB_SIZE),
    }
    this.tiles.set(key(tx, ty), tile)
    return tile
  }

  takeDirty(): Tile[] {
    const out: Tile[] = []
    for (const k of this.dirty) {
      const t = this.tiles.get(k)
      if (t) out.push(t)
    }
    this.dirty.clear()
    return out
  }

  /** Approximate (tile-granular) bounds, cheap. */
  tileBounds(): Bounds | null {
    if (this.tiles.size === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const t of this.tiles.values()) {
      minX = Math.min(minX, t.tx)
      minY = Math.min(minY, t.ty)
      maxX = Math.max(maxX, t.tx + 1)
      maxY = Math.max(maxY, t.ty + 1)
    }
    return {
      minX: minX * TILE_SIZE,
      minY: minY * TILE_SIZE,
      maxX: maxX * TILE_SIZE,
      maxY: maxY * TILE_SIZE,
    }
  }

  /** Exact bounds of covered pixels (scans tile quality buffers). */
  exactBounds(): Bounds | null {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const t of this.tiles.values()) {
      const ox = t.tx * TILE_SIZE
      const oy = t.ty * TILE_SIZE
      // Skip interior scanning when the tile can't extend the current bounds.
      if (ox >= minX && oy >= minY && ox + TILE_SIZE <= maxX && oy + TILE_SIZE <= maxY) continue
      for (let y = 0; y < TILE_SIZE; y++) {
        const row = y * TILE_SIZE
        for (let x = 0; x < TILE_SIZE; x++) {
          if (t.q[row + x] === 0) continue
          const wx = ox + x
          const wy = oy + y
          if (wx < minX) minX = wx
          if (wx + 1 > maxX) maxX = wx + 1
          if (wy < minY) minY = wy
          if (wy + 1 > maxY) maxY = wy + 1
        }
      }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY }
  }

  /**
   * Inpaints thin holes (≤ `maxGap` px, e.g. map areas only ever seen behind a HUD
   * element) by interpolating between the covered pixels on either side, first along
   * rows, then along columns. Filled pixels get quality 1, so any real observation
   * captured later still replaces them.
   * @returns number of pixels filled
   */
  fillGaps(maxGap: number): number {
    const b = this.exactBounds()
    if (!b) return 0
    const W = b.maxX - b.minX
    const H = b.maxY - b.minY
    const n = Math.max(W, H)
    const col = new Uint32Array(n)
    const q = new Uint8Array(n)
    let filled = 0

    let cacheKey = -1
    let cacheTile: Tile | undefined
    const tileAt = (wx: number, wy: number, create: boolean): Tile | undefined => {
      const k = key(wx >> TILE_SHIFT, wy >> TILE_SHIFT)
      if (k !== cacheKey || (!cacheTile && create)) {
        cacheKey = k
        cacheTile = this.tiles.get(k) ?? (create ? this.createTile(wx >> TILE_SHIFT, wy >> TILE_SHIFT) : undefined)
      }
      return cacheTile
    }

    for (const horizontal of [true, false]) {
      const len = horizontal ? W : H
      const lines = horizontal ? H : W
      for (let line = 0; line < lines; line++) {
        const at = (i: number): [number, number] =>
          horizontal ? [b.minX + i, b.minY + line] : [b.minX + line, b.minY + i]
        // Read the line.
        let any = false
        for (let i = 0; i < len; i++) {
          const [wx, wy] = at(i)
          const t = tileAt(wx, wy, false)
          const ti = (wy & TILE_MASK) * TILE_SIZE + (wx & TILE_MASK)
          q[i] = t ? t.q[ti] : 0
          col[i] = t ? t.rgba32[ti] : 0
          if (q[i] === 0) any = true
        }
        if (!any) continue
        // Fill bounded runs of empty pixels.
        let i = 0
        while (i < len) {
          if (q[i] !== 0) {
            i++
            continue
          }
          const start = i
          while (i < len && q[i] === 0) i++
          const end = i // exclusive
          const gap = end - start
          if (start === 0 || end === len || gap > maxGap) continue
          const c0 = col[start - 1]
          const c1 = col[end]
          for (let j = start; j < end; j++) {
            const f = (j - start + 1) / (gap + 1)
            const r = Math.round((c0 & 0xff) * (1 - f) + (c1 & 0xff) * f)
            const g = Math.round(((c0 >>> 8) & 0xff) * (1 - f) + ((c1 >>> 8) & 0xff) * f)
            const bl = Math.round(((c0 >>> 16) & 0xff) * (1 - f) + ((c1 >>> 16) & 0xff) * f)
            const [wx, wy] = at(j)
            const t = tileAt(wx, wy, true)!
            const ti = (wy & TILE_MASK) * TILE_SIZE + (wx & TILE_MASK)
            t.rgba32[ti] = 0xff000000 | (bl << 16) | (g << 8) | r
            t.lum[ti] = (r * 77 + g * 150 + bl * 29 + 128) >> 8
            t.q[ti] = 1
            t.n[ti] = 1
            this.dirty.add(key(t.tx, t.ty))
            this.thumbDirty.add(key(t.tx, t.ty))
            filled++
          }
        }
      }
    }
    return filled
  }

  /**
   * Thumbnail of the whole map at 1/THUMB_SCALE, padded by `padX`/`padY` thumbnail
   * pixels of "uncovered" on every side.
   */
  thumbMap(padX: number, padY: number): ThumbMap | null {
    for (const k of this.thumbDirty) {
      const t = this.tiles.get(k)
      if (t) updateThumb(t)
    }
    this.thumbDirty.clear()
    const b = this.tileBounds()
    if (!b) return null
    const tw = (b.maxX - b.minX) / THUMB_SCALE
    const th = (b.maxY - b.minY) / THUMB_SCALE
    const w = tw + 2 * padX
    const h = th + 2 * padY
    const lum = new Float32Array(w * h)
    const ok = new Uint8Array(w * h)
    for (const t of this.tiles.values()) {
      const ox = (t.tx * TILE_SIZE - b.minX) / THUMB_SCALE + padX
      const oy = (t.ty * TILE_SIZE - b.minY) / THUMB_SCALE + padY
      for (let y = 0; y < THUMB_SIZE; y++) {
        const dst = (oy + y) * w + ox
        lum.set(t.thumb.subarray(y * THUMB_SIZE, (y + 1) * THUMB_SIZE), dst)
        ok.set(t.thumbOk.subarray(y * THUMB_SIZE, (y + 1) * THUMB_SIZE), dst)
      }
    }
    return { lum, ok, w, h, x0: b.minX - padX * THUMB_SCALE, y0: b.minY - padY * THUMB_SCALE }
  }

  /**
   * Copies luma and quality of a world rectangle into contiguous buffers.
   * Missing tiles read as q = 0.
   */
  extract(
    x0: number,
    y0: number,
    w: number,
    h: number,
    outLum: Uint8Array,
    outQ: Uint8Array,
    outN?: Uint8Array,
  ): void {
    outQ.fill(0, 0, w * h)
    const tx0 = x0 >> TILE_SHIFT
    const ty0 = y0 >> TILE_SHIFT
    const tx1 = (x0 + w - 1) >> TILE_SHIFT
    const ty1 = (y0 + h - 1) >> TILE_SHIFT
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.getTile(tx, ty)
        if (!t) continue
        const wx0 = Math.max(x0, tx * TILE_SIZE)
        const wx1 = Math.min(x0 + w, (tx + 1) * TILE_SIZE)
        const wy0 = Math.max(y0, ty * TILE_SIZE)
        const wy1 = Math.min(y0 + h, (ty + 1) * TILE_SIZE)
        const span = wx1 - wx0
        for (let wy = wy0; wy < wy1; wy++) {
          const src = (wy & TILE_MASK) * TILE_SIZE + (wx0 & TILE_MASK)
          const dst = (wy - y0) * w + (wx0 - x0)
          outLum.set(t.lum.subarray(src, src + span), dst)
          outQ.set(t.q.subarray(src, src + span), dst)
          outN?.set(t.n.subarray(src, src + span), dst)
        }
      }
    }
  }

  // Scratch buffers for composite(), sized to the frame.
  private sLum = new Uint8Array(0)
  private sQ = new Uint8Array(0)
  private sN = new Uint8Array(0)
  private fLum = new Uint8Array(0)
  private fScore = new Uint8Array(0)
  private cls = new Uint8Array(0)
  private blockConflicts = new Uint16Array(0)
  private blockInvalid = new Uint8Array(0)
  private blockLabel = new Int32Array(0)
  private stack = new Int32Array(0)

  /**
   * Writes a frame into the map, seam-aware:
   *
   * 1. Each frame pixel is classified against the map: NEW (map empty), AGREE, or
   *    CONFLICT (|luma difference| > CONFLICT_DIFF: animation, cursor, laser, ...).
   * 2. Conflicting pixels are grouped into blobs on a BLOCK grid (dilated so a blob
   *    covers the whole object). Each blob is taken entirely from the frame or kept
   *    entirely from the map, so seams run through areas where both agree (floor,
   *    grass) and never cut a facility in half. Blobs touching the frame's edge or the
   *    HUD are never taken from the frame: that object is only partly visible.
   * 3. A blob goes to the frame if it wins the vote: frame quality vs. stored quality
   *    weighted by how many frames confirmed the stored version. Unconfirmed content
   *    (seen once) loses easily, so cursors and odd animation frames get replaced.
   * 4. Agreeing pixels keep the sharper observation and gain confirmation.
   * @returns number of pixels written
   */
  composite(f: CompositeInput): number {
    const { rgba32, lum, q, width: W, height: H, x: fx0, y: fy0, gain, gainW, gainH, gainScale } = f
    const n = W * H
    if (this.sLum.length < n) {
      this.sLum = new Uint8Array(n)
      this.sQ = new Uint8Array(n)
      this.sN = new Uint8Array(n)
      this.fLum = new Uint8Array(n)
      this.fScore = new Uint8Array(n)
      this.cls = new Uint8Array(n)
    }
    const bw = Math.ceil(W / BLOCK)
    const bh = Math.ceil(H / BLOCK)
    const nb = bw * bh
    if (this.blockConflicts.length < nb) {
      this.blockConflicts = new Uint16Array(nb)
      this.blockInvalid = new Uint8Array(nb)
      this.blockLabel = new Int32Array(nb)
      this.stack = new Int32Array(nb)
    }
    const { sLum, sQ, sN, fLum, fScore, cls, blockConflicts, blockInvalid, blockLabel, stack } = this
    if (this.gainCol.length < W) this.gainCol = new Int32Array(W)
    const gainCol = this.gainCol
    for (let x = 0; x < W; x++) gainCol[x] = Math.min(gainW - 1, (x / gainScale) | 0)

    this.extract(fx0, fy0, W, H, sLum, sQ, sN)

    // ---- 1. classify
    blockConflicts.fill(0, 0, nb)
    blockInvalid.fill(0, 0, nb)
    const lw = Math.ceil(W / LIGHT_BLOCK)
    const lh = Math.ceil(H / LIGHT_BLOCK)
    const lightSum = new Int32Array(lw * lh)
    const lightCnt = new Int32Array(lw * lh)
    const sf = Math.max(0.05, Math.min(1, f.speedFactor))
    for (let y = 0; y < H; y++) {
      const row = y * W
      const grow = Math.min(gainH - 1, (y / gainScale) | 0) * gainW
      const brow = (y >> BLOCK_SHIFT) * bw
      for (let x = 0; x < W; x++) {
        const i = row + x
        const fq = q[i]
        if (fq === 0) {
          cls[i] = SKIP
          blockInvalid[brow + (x >> BLOCK_SHIFT)] = 1
          continue
        }
        const fs = (fq * sf) | 0
        fScore[i] = fs > 0 ? fs : 1
        let fl = (lum[i] * gain[grow + gainCol[x]] + 128) >> 8
        if (fl > 255) fl = 255
        fLum[i] = fl
        cls[i] = sQ[i] === 0 ? NEW : AGREE // AGREE is provisional, refined below
      }
    }
    // Structural difference only: remove each LIGHT_BLOCK area's mean brightness
    // offset first, so vignettes / cloud shadows / older lighting don't read as
    // "different content". Lighting is smooth, so a 1-in-16 subsample is plenty.
    for (let y = 1; y < H; y += 4) {
      const row = y * W
      const lrow = (y >> LIGHT_SHIFT) * lw
      for (let x = 1; x < W; x += 4) {
        const i = row + x
        if (cls[i] !== AGREE) continue
        const L = lrow + (x >> LIGHT_SHIFT)
        lightSum[L] += sLum[i] - fLum[i]
        lightCnt[L]++
      }
    }
    for (let L = 0; L < lw * lh; L++) lightSum[L] = lightCnt[L] > 0 ? Math.round(lightSum[L] / lightCnt[L]) : 0
    for (let y = 0; y < H; y++) {
      const row = y * W
      const brow = (y >> BLOCK_SHIFT) * bw
      const lrow = (y >> LIGHT_SHIFT) * lw
      for (let x0 = 0; x0 < W; x0 += LIGHT_BLOCK) {
        const off = lightSum[lrow + (x0 >> LIGHT_SHIFT)]
        const x1 = Math.min(W, x0 + LIGHT_BLOCK)
        for (let x = x0; x < x1; x++) {
          const i = row + x
          if (cls[i] !== AGREE) continue
          const d = fLum[i] + off - sLum[i]
          if (d > CONFLICT_DIFF || d < -CONFLICT_DIFF) {
            cls[i] = CONFLICT
            blockConflicts[brow + (x >> BLOCK_SHIFT)]++
          }
        }
      }
    }
    // The frame border counts as invalid too: objects there are cut off.
    for (let bx = 0; bx < bw; bx++) blockInvalid[bx] = blockInvalid[(bh - 1) * bw + bx] = 1
    for (let by = 0; by < bh; by++) blockInvalid[by * bw] = blockInvalid[by * bw + bw - 1] = 1

    // ---- 2. conflict blobs: blocks with >= 2 conflicting pixels, dilated by one block
    blockLabel.fill(0, 0, nb)
    for (let b = 0; b < nb; b++) {
      if (blockConflicts[b] < 2) continue
      const bx = b % bw
      const by = (b / bw) | 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = by + dy
        if (yy < 0 || yy >= bh) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = bx + dx
          if (xx >= 0 && xx < bw) blockLabel[yy * bw + xx] = -1 // in a blob, not labelled yet
        }
      }
    }
    let blobs = 0
    for (let b = 0; b < nb; b++) {
      if (blockLabel[b] !== -1) continue
      blobs++
      let sp = 0
      stack[sp++] = b
      blockLabel[b] = blobs
      while (sp > 0) {
        const c = stack[--sp]
        const cx = c % bw
        const cy = (c / bw) | 0
        if (cx > 0 && blockLabel[c - 1] === -1) {
          blockLabel[c - 1] = blobs
          stack[sp++] = c - 1
        }
        if (cx < bw - 1 && blockLabel[c + 1] === -1) {
          blockLabel[c + 1] = blobs
          stack[sp++] = c + 1
        }
        if (cy > 0 && blockLabel[c - bw] === -1) {
          blockLabel[c - bw] = blobs
          stack[sp++] = c - bw
        }
        if (cy < bh - 1 && blockLabel[c + bw] === -1) {
          blockLabel[c + bw] = blobs
          stack[sp++] = c + bw
        }
      }
    }

    // ---- 3. vote per blob
    const votesF = new Float64Array(blobs + 1)
    const votesM = new Float64Array(blobs + 1)
    const sumN = new Float64Array(blobs + 1)
    const count = new Float64Array(blobs + 1)
    const sumMQ = new Float64Array(blobs + 1)
    const sumFQ = new Float64Array(blobs + 1)
    const invalid = new Uint8Array(blobs + 1)
    for (let b = 0; b < nb; b++) if (blockLabel[b] > 0 && blockInvalid[b]) invalid[blockLabel[b]] = 1
    if (blobs > 0) {
      for (let y = 0; y < H; y++) {
        const row = y * W
        const brow = (y >> BLOCK_SHIFT) * bw
        for (let x = 0; x < W; x++) {
          const i = row + x
          const c = cls[i]
          if (c !== AGREE && c !== CONFLICT) continue
          const label = blockLabel[brow + (x >> BLOCK_SHIFT)]
          if (label <= 0) continue
          const nn = sN[i] || 1
          const mScore = sQ[i] * (1 + 0.5 * Math.min(nn - 1, 4))
          const fs = fScore[i]
          if (fs > mScore) votesF[label]++
          else if (fs < mScore) votesM[label]++
          else {
            // A tie is a second opinion: split the vote.
            votesF[label] += 0.5
            votesM[label] += 0.5
          }
          sumN[label] += nn
          sumMQ[label] += sQ[i]
          sumFQ[label] += fs
          count[label]++
        }
      }
    }
    // takeFrame: 0 = keep map, 1 = take frame, 2 = not an object (decide per pixel)
    const takeFrame = new Uint8Array(blobs + 1)
    const maxBlob = Math.max(MAX_BLOB_FRACTION * W * H, 128 * 128)
    for (let k = 1; k <= blobs; k++) {
      if (count[k] === 0) continue
      if (count[k] > maxBlob) {
        takeFrame[k] = 2
        continue
      }
      const unconfirmed = sumN[k] / count[k] < 1.5
      if (invalid[k]) {
        // A partly visible object never replaces a whole one that other frames have
        // confirmed, unless the stored copy is really poor (captured right at a frame
        // edge). Unconfirmed content (e.g. HUD text that leaked in once) gets a plain
        // vote instead, so a clean, central observation can replace it.
        if (!unconfirmed && sumMQ[k] >= 0.25 * sumFQ[k]) continue
        takeFrame[k] = votesF[k] > votesM[k] ? 1 : 0
        continue
      }
      takeFrame[k] = (unconfirmed ? votesF[k] * 2 >= votesM[k] : votesF[k] > votesM[k]) ? 1 : 0
    }

    // ---- 4. write
    const confirm = f.confirm
    let written = 0
    const tx0 = fx0 >> TILE_SHIFT
    const ty0 = fy0 >> TILE_SHIFT
    const tx1 = (fx0 + W - 1) >> TILE_SHIFT
    const ty1 = (fy0 + H - 1) >> TILE_SHIFT
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        let t = this.getTile(tx, ty)
        const wx0 = Math.max(fx0, tx * TILE_SIZE)
        const wx1 = Math.min(fx0 + W, (tx + 1) * TILE_SIZE)
        const wy0 = Math.max(fy0, ty * TILE_SIZE)
        const wy1 = Math.min(fy0 + H, (ty + 1) * TILE_SIZE)
        let touched = false
        for (let wy = wy0; wy < wy1; wy++) {
          const fy = wy - fy0
          const fOff = fy * W - fx0
          const brow = (fy >> BLOCK_SHIFT) * bw
          const grow = Math.min(gainH - 1, (fy / gainScale) | 0) * gainW
          const tOff = (wy & TILE_MASK) * TILE_SIZE - (wx0 & ~TILE_MASK)
          for (let wx = wx0; wx < wx1; wx++) {
            const fi = fOff + wx
            const c = cls[fi]
            if (c === SKIP) continue
            const ti = tOff + wx
            let write: boolean
            let newN: number
            if (c === NEW) {
              write = true
              newN = 1
            } else {
              const label = blockLabel[brow + ((wx - fx0) >> BLOCK_SHIFT)]
              const nn = sN[fi] || 1
              if (label > 0 && takeFrame[label] !== 2) {
                write = takeFrame[label] === 1
                if (c === AGREE) newN = confirm ? Math.min(255, nn + 1) : nn
                else newN = write ? 1 : Math.max(1, nn - 1)
              } else if (c === AGREE) {
                write = fScore[fi] > sQ[fi]
                newN = confirm ? Math.min(255, nn + 1) : nn
              } else {
                // Isolated conflicting pixel (noise): just keep the sharper observation.
                write = fScore[fi] > sQ[fi]
                newN = nn
              }
            }
            if (!t) t = this.createTile(tx, ty)
            if (write) {
              const gn = gain[grow + gainCol[wx - fx0]]
              const p = rgba32[fi]
              // Round (not floor): flooring biases every generation of chained
              // lighting normalisation and the map slowly darkens.
              let r = ((p & 0xff) * gn + 128) >> 8
              let g = (((p >>> 8) & 0xff) * gn + 128) >> 8
              let b = (((p >>> 16) & 0xff) * gn + 128) >> 8
              if (r > 255) r = 255
              if (g > 255) g = 255
              if (b > 255) b = 255
              t.rgba32[ti] = 0xff000000 | (b << 16) | (g << 8) | r
              t.lum[ti] = fLum[fi]
              t.q[ti] = fScore[fi]
              written++
              touched = true
            }
            if (newN !== sN[fi]) t.n[ti] = newN
          }
        }
        if (touched) {
          this.dirty.add(key(tx, ty))
          this.thumbDirty.add(key(tx, ty))
        }
      }
    }
    return written
  }
}

function updateThumb(t: Tile): void {
  const S = THUMB_SCALE
  for (let by = 0; by < THUMB_SIZE; by++) {
    for (let bx = 0; bx < THUMB_SIZE; bx++) {
      let sum = 0
      let n = 0
      for (let y = by * S; y < (by + 1) * S; y++) {
        const row = y * TILE_SIZE
        for (let x = bx * S; x < (bx + 1) * S; x++) {
          if (t.q[row + x] === 0) continue
          sum += t.lum[row + x]
          n++
        }
      }
      const i = by * THUMB_SIZE + bx
      t.thumb[i] = n > 0 ? sum / n : 0
      t.thumbOk[i] = n > (S * S * 3) / 4 ? 1 : 0
    }
  }
}
