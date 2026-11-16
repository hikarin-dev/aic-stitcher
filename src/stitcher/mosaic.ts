import { boxSum } from './image'
import { MinCut } from './mincut'

export const TILE_SHIFT = 9
export const TILE_SIZE = 1 << TILE_SHIFT // 512
const TILE_MASK = TILE_SIZE - 1
const TILE_PIXELS = TILE_SIZE * TILE_SIZE
/** Downscale factor of the thumbnail map used for global relocalization. */
export const THUMB_SCALE = 32
const THUMB_SIZE = TILE_SIZE / THUMB_SCALE

/** The lighting layer has one cell per LIGHT_CELL² map pixels. */
export const LIGHT_SHIFT = 3
export const LIGHT_CELL = 1 << LIGHT_SHIFT
const LIGHT_SIZE = TILE_SIZE >> LIGHT_SHIFT // 64 cells per tile side
const LIGHT_MASK = LIGHT_SIZE - 1
/** Lighting cells of a tile plus a one-cell border from its neighbours (for interpolation). */
const PAD = LIGHT_SIZE + 2

/**
 * Terms of the vignette model: log V(u, v) = θ · [u², v², u⁴, v⁴, u²v², u, v], with u, v
 * the screen position in -1..1. Smooth and even-ish, like a game's vignette post-effect.
 */
export const VIG_TERMS = 7
/**
 * Starting guess for θ: the screen-fixed darkening measured in Arknights: Endfield's
 * AIC top-down view from pairs of still frames (a vignette plus the soft gradients
 * behind the HUD: the top and bottom edges are ~30 % darker than the centre, the
 * corners about half as bright). It is re-estimated from the frames themselves, so a
 * different game or setting only starts out wrong.
 */
export const ENDFIELD_VIGNETTE = [0.02, 0.005, -0.5, -0.93, -0.26, -0.12, 0.15]

/** Fixed-point scale of `Tile.shade`. */
export const SHADE_ONE = 64
/** Brightness that lighting-normalised luma maps a pixel's surroundings to. */
export const NORM_LEVEL = 100
/** Surroundings darker than this are not normalised any further (it would only amplify noise). */
export const NORM_FLOOR = 24

/** Confidence grid: one cell per CONF_CELL² map pixels. */
export const CONF_CELL = 16
export const CONF_SIZE = TILE_SIZE / CONF_CELL
/** Pixels stored below this quality were only ever seen at a frame edge, next to the HUD or badly blurred. */
export const WEAK_Q = 56
/** Pixels at/above this quality come from a frame taken while the camera stood still. */
export const SHARP_Q = 190

export interface Tile {
  tx: number
  ty: number
  /**
   * Detail layer: the colour as it was captured (little-endian ABGR words, alpha 255
   * where covered), with that frame's lighting still in it. See `shade`.
   */
  raw32: Uint32Array
  /**
   * How bright the source frame was around this pixel (low-pass luma × SHADE_ONE).
   * Dividing the colour by it removes the frame's lighting; multiplying by the
   * lighting layer puts the map's shared lighting back.
   */
  shade: Uint16Array
  /** Lighting-normalised luma (surroundings → NORM_LEVEL). Alignment and conflict detection use this. */
  lum: Uint8Array
  /** Quality of the stored pixel, 0 = empty. Higher = sharper frame, further from frame/HUD edges. */
  q: Uint8Array
  /**
   * How many independent frames agreed with the stored pixel (1 = seen once). Content
   * confirmed from several camera positions is hard to replace; one-off content (a
   * cursor, a transient animation frame) loses as soon as other frames disagree.
   */
  n: Uint8Array
  /**
   * Lighting layer: weighted mean of the log local brightness of every frame that saw
   * this cell. Averaging it (instead of keeping one frame's lighting per pixel) is
   * what makes brightness change smoothly across the map.
   */
  light: Float32Array
  /** Accumulated weight behind `light` (0 = no observation). */
  lightW: Float32Array
  /**
   * Weighted mean of the vignette basis at the screen positions this cell was seen
   * from (VIG_TERMS values per cell). The vignette's share of `light` is θ · this, so
   * it can be taken out again with whatever θ is known *now*: improving the vignette
   * estimate corrects the whole map, including what was captured before.
   */
  lightPhi: Float32Array
  /** Mean luma per THUMB_SCALE² block, for global relocalization. */
  thumb: Float32Array
  /** 1 where the thumbnail block is mostly covered. */
  thumbOk: Uint8Array
  /** Cached pixel counts for `Mosaic.stats()`; null after the tile changed. */
  counts: { covered: number; weak: number; soft: number } | null
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
  /** Per-pixel quality, 0 = don't use (HUD, cropped). */
  q: Uint8Array
  width: number
  height: number
  /** World position of the frame's top-left pixel. */
  x: number
  y: number
  /**
   * Local brightness of the frame (low-pass luma), `shadeW`×`shadeH`, one value per
   * `shadeScale`² frame pixels. Must be positive everywhere.
   */
  shade: Float32Array
  /** How much each shade cell counts towards the lighting layer: 0 = HUD / cropped … 1 = frame centre. */
  shadeWeight: Float32Array
  shadeW: number
  shadeH: number
  shadeScale: number
  /**
   * Optional 0..1 quality multiplier on the same grid as `shade`: how settled the
   * content of each cell is (the game pops icons in a moment after they scroll into view).
   */
  fresh?: Float32Array
  /** Multiplier on `shadeWeight`, < 1 for repeated frames from the same camera position. Default 1. */
  lightScale?: number
  /** 0..1 multiplier on frame quality: blurry (moving) frames get less. */
  speedFactor: number
  /** Whether agreement from this frame counts as confirmation (a view from a new camera position). */
  confirm: boolean
  /** 'fill' only writes pixels the map doesn't have yet. Default 'full'. */
  mode?: 'full' | 'fill'
  /** Leave the lighting layer alone (the frame is already part of it). */
  skipLight?: boolean
  /**
   * For the frames of one stop of the camera, which all show the same view: which of
   * the frame's pixels that stop has put into the map so far (1). Kept up to date here.
   *
   * A stop is one picture. However long the camera rests, whatever the stop has
   * contributed is renewed as a whole from each of its frames, and nothing is blended
   * or kept in part. Without this, the pixels of a stop trickle in over many frames
   * (the first frames after stopping are rated lower, what has just scrolled in
   * matures cell by cell), each from a different moment: belts and machines, which
   * never look the same twice, end up put together from all of them.
   */
  own?: Uint8Array
  /**
   * The frame is a still being assembled with other stills (screenshots, or the stops
   * of a recording), which may have been taken far apart.
   *
   * The game's camera has perspective: raised things (pipes, floating icons) sit a few
   * pixels apart in two views of the same ground taken a few hundred pixels apart.
   * Mixing such views piece by piece shreds every pipe that runs through the overlap.
   * So here each pixel simply goes to the view that rates it higher, which gives one
   * clean seam per overlap, with one exception: an object small enough to be judged
   * as a whole (a facility, an icon) is taken whole from one view, so the seam goes
   * round it. No witnesses, no parts, next to no blending.
   */
  assemble?: boolean
}

/** A rectangle of the map, in world pixels. */
export interface WorldBox {
  x: number
  y: number
  w: number
  h: number
}

export interface CompositeResult {
  /**
   * composite() only: where something that had sat on the screen during a stop (the
   * cursor, a tooltip) was found in the map and is being thrown out.
   */
  transients?: WorldBox[]
  /**
   * composite() only: small objects this frame shows that the map does not, where the
   * map keeps its version and an earlier frame from another camera position saw what
   * the map has: two looks against one. In a frame taken while the camera stood still,
   * that is something on the screen rather than in the world (the cursor again).
   */
  contradicted?: WorldBox[]
  /**
   * assemble() only: length in pixels of the border between the still and the rest
   * that runs through content the two views disagree on (a visible seam), and the
   * length of the whole border.
   */
  seamThroughConflict?: number
  seamLength?: number
  /** Pixels written (new, replaced or blended). */
  written: number
  /** Pixels the map did not have before. */
  filled: number
  /** Valid frame pixels that overlapped existing map content. */
  overlap: number
  /** Of those, how many showed different content (not just different lighting or blur). */
  conflicts: number
}

export interface MapStats {
  covered: number
  /** Pixels stored with quality below WEAK_Q. */
  weak: number
  /** Pixels that are not weak but were never captured from a still frame. */
  soft: number
}

/** Brightness difference (grey levels) above which frame and map may disagree (animation, cursor, laser...). */
const CONFLICT_DIFF = 22
/** NORM_FLOOR in the units of `Tile.shade`. */
const SHADE_FLOOR = NORM_FLOOR * SHADE_ONE
/** ...and their surroundings must differ by this much on average too. */
const CONFLICT_MEAN_DIFF = 12
/** Radius of those surroundings, in blocks. */
const MEAN_RADIUS = 2
/** Conflict analysis block size in pixels (power of two). */
const BLOCK_SHIFT = 2
const BLOCK = 1 << BLOCK_SHIFT
/**
 * Blocks a conflict blob is grown by on every side. Enough to take in the blur halo
 * around a moving item: left outside, the halo would be written on its own and show up
 * as a ghost outline around where the item used to be.
 */
const BLOB_GROW = 2
/** Conflict blobs bigger than this fraction of the frame aren't one object: they are decided part by part. */
const MAX_BLOB_FRACTION = 0.1
/** Confirmation count saturates here, so stale content can still be overturned in bounded time. */
const N_MAX = 6
/**
 * Quality lead a frame needs before it replaces what the map has. An equally good look
 * never does, so every pixel keeps one sample instead of flickering between frames.
 */
const SWITCH_LEAD = 24
/** Agreeing pixels fade over between these leads: a feathered seam instead of a hard one. */
const FEATHER_LO = 12
const FEATHER_HI = 36
/** The same for stills being assembled (see CompositeInput.assemble): any lead decides. */
const ASSEMBLE_LEAD = 1
const ASSEMBLE_FEATHER = 4
/**
 * Against content other frames confirmed, a pixel is only a witness in the best part
 * of its frame (this share of the frame's top quality): what has just scrolled in, or
 * sits near the screen edge where the game hides facility icons, proves nothing.
 */
const WITNESS_ZONE = 0.9
/**
 * Longest side (px) of a blob that still counts as one object (a facility). When the
 * frame edge or the HUD cuts such a blob, the frame doesn't get to update it.
 */
const OBJECT_MAX_SIDE = 420
/**
 * Two frames from different camera positions contradict the map "exactly" when this
 * share of a blob agrees between them within TRANSIENT_DIFF grey levels. A blob up to
 * TRANSIENT_MAX_AREA pixels that no second camera position ever confirmed is then a
 * transient: something that sat on the screen while the camera stood still.
 */
const TRANSIENT_MAX_AREA = 64 * 64
const TRANSIENT_SHARE = 0.9
const TRANSIENT_DIFF = 10
/** Frame quality from which a pixel may testify against content nobody ever confirmed. */
const TRANSIENT_MIN_Q = 40
/** A transient is replaced on the spot by a frame with at least this share of its quality. */
const TRANSIENT_TAKE = 0.4
/** Share of a frame's top quality a pixel needs before its agreement counts as confirmation. */
const CONFIRM_ZONE = 0.5
/**
 * Stored pixels at/above this quality that several camera positions agreed on are
 * settled: a frame showing something else there (the cursor, a tooltip) does not get
 * to replace them just for being sharper. It takes two witnesses.
 */
const SETTLED_Q = 150
/** Weight at which the lighting layer becomes a moving average (newer frames keep counting). */
const LIGHT_CAP = 4
/** Weight of a lighting value extrapolated into the HUD / past the frame edge (a placeholder). */
const LIGHT_EPS = 1e-3
/** Frames whose lighting statistics are folded into the vignette estimate between solves. */
const VIG_SOLVE_EVERY = 6
/** Pull of the vignette estimate towards its starting guess (in units of observation weight). */
const VIG_PRIOR_WEIGHT = 400
/**
 * The linear terms (a left-right / top-bottom tilt) get a much stronger pull: a cloud
 * shadow lying across the screen looks exactly like such a tilt for a while.
 */
const VIG_PRIOR_WEIGHT_LINEAR = 20000
/**
 * Cloud shadows drift over the map within seconds, so a frame rarely has the lighting
 * the map has. The large-scale difference (blurred over about a quarter of the frame)
 * is taken out of the frame before it joins the lighting layer...
 */
const RELIGHT_RADIUS = 0.11
/** ...unless the frame is the brighter one: then the map is raised towards it, by this share per frame. */
const RELIGHT_RAISE = 0.5
/** Brightness lead (log units) below which the map is not raised: keeps noise from ratcheting it up. */
const RELIGHT_DEADBAND = 0.01
/** Lighting weight a cell needs before frames are compared against it. */
const RELIGHT_MIN_WEIGHT = 0.3
/** The map is redrawn when a new vignette estimate changes brightness by more than this (log units). */
const VIG_REDRAW = 0.004
/** Keeps the lighting ratio near 1 in very dark areas, where it is mostly noise. */
const RATIO_SOFT = 6
const RATIO_MIN = 0.5
const RATIO_MAX = 2
// ---- assembling stills (see Mosaic.assemble)
/**
 * Ratings (0..255) say how much a view should own a pixel. A still rates its pixels
 * RATING_CORE and up inside its core, rising towards its middle, and below that in
 * its margin (where the game hides facility icons). See Stitcher for the exact shape.
 */
export const RATING_CORE = 128
/** Map content captured mid-screen: as good as a still at the rim of its core. */
const RATING_CAPTURE_CORE = 127
/** The most a still gets for content that had only just scrolled into view (its icons may not be up yet). */
const RATING_UNSETTLED = 100
/** Map content only ever seen near a screen edge. */
const RATING_CAPTURE_EDGE = 4
/** Stored quality from which map content counts as captured mid-screen. */
const CAPTURE_CORE_Q = 140
/** A cell whose views differ in rating by more than this simply goes to the better one. */
const SEAM_BAND = 48
/** Colour difference (grey levels) that noise and video compression account for. */
const SEAM_NOISE = 5
/** A border between cells that differ by more than this (beyond noise) shows. */
const SEAM_VISIBLE = 12
/** Beyond this a border is as bad as it gets. */
const SEAM_MAX_DIFF = 60
/** Cost of a border per cell even where the views agree: keeps it short and straight. */
const SEAM_LENGTH = 1
/** Capacities are integers: costs are multiplied by this. */
const SEAM_SCALE = 16
/** Pull towards the better-rated view, per pixel and rating point (in SEAM_SCALE units). */
const SEAM_PULL = 0.02 * SEAM_SCALE
/** Pull per pixel that the still fills in anyway (the map had nothing there). */
const SEAM_NEW = 40 * SEAM_SCALE
const TAKE = -1
const KEEP = -2
/**
 * A still is not used where it is suspected of showing something that only sat on the
 * screen (see assemble): if, there, this many cells differ from the map by at least
 * this much on average (grey levels beyond SEAM_NOISE). A cursor is some 40 px across
 * and nothing like the ground under it.
 */
const SUSPECT_DIFF = 30
const SUSPECT_CELLS = 6
/** Cells left out around such a place, for the soft edge of whatever it is. */
const SUSPECT_GROW = 2

// Pixel classes used by composite().
const SKIP = 0
const NEW = 1
const AGREE = 2
const CONFLICT = 3

const key = (tx: number, ty: number) => (tx + 32768) * 65536 + (ty + 32768)

// Bilinear lookup tables from a tile pixel to the padded lighting grid.
const LIGHT_IDX = new Int32Array(TILE_SIZE)
const LIGHT_FRAC = new Float32Array(TILE_SIZE)
for (let i = 0; i < TILE_SIZE; i++) {
  const u = (i + 0.5) / LIGHT_CELL - 0.5 // -0.44 … 63.44
  const i0 = Math.floor(u)
  LIGHT_IDX[i] = i0 + 1 // padded index
  LIGHT_FRAC[i] = u - i0
}

export class Mosaic {
  readonly tiles = new Map<number, Tile>()
  /** false = show every pixel with the lighting of the frame it came from (no lighting layer). */
  blendLighting = true
  /** Current vignette estimate θ (see VIG_TERMS). */
  readonly vignette = new Float64Array(ENDFIELD_VIGNETTE)
  /** false = keep the starting guess instead of refining it from the frames. */
  learnVignette = true
  private vigM = new Float64Array(VIG_TERMS * VIG_TERMS)
  private vigB = new Float64Array(VIG_TERMS)
  private vigFrames = 0
  private vigSamples = new Float32Array(0)
  /** Tiles modified since the last `takeDirty()`. */
  private dirty = new Set<number>()
  /** Tiles whose thumbnail needs recomputing. */
  private thumbDirty = new Set<number>()

  get isEmpty(): boolean {
    return this.tiles.size === 0
  }

  clear(): void {
    this.tiles.clear()
    this.dirty.clear()
    this.thumbDirty.clear()
    this.prevW = 0
    this.pastW = 0
  }

  /** Marks every tile as changed (after something that affects the whole map). */
  touchAll(): void {
    for (const t of this.tiles.values()) this.touch(t)
  }

  /** Forgets the learned vignette (back to the starting guess). */
  resetVignette(): void {
    this.vignette.set(ENDFIELD_VIGNETTE)
    this.vigM.fill(0)
    this.vigB.fill(0)
    this.vigFrames = 0
    for (const t of this.tiles.values()) this.touch(t)
  }

  /** Vignette-free lighting of cell `li` of tile `t` (0 = not observed). */
  private cellLight(t: Tile, li: number): number {
    if (t.lightW[li] <= 0) return 0
    const th = this.vignette
    const o = li * VIG_TERMS
    let v = t.light[li]
    for (let k = 0; k < VIG_TERMS; k++) v -= th[k] * t.lightPhi[o + k]
    return Math.exp(v)
  }

  getTile(tx: number, ty: number): Tile | undefined {
    return this.tiles.get(key(tx, ty))
  }

  private createTile(tx: number, ty: number): Tile {
    const tile: Tile = {
      tx,
      ty,
      raw32: new Uint32Array(TILE_PIXELS),
      shade: new Uint16Array(TILE_PIXELS),
      lum: new Uint8Array(TILE_PIXELS),
      q: new Uint8Array(TILE_PIXELS),
      n: new Uint8Array(TILE_PIXELS),
      light: new Float32Array(LIGHT_SIZE * LIGHT_SIZE),
      lightW: new Float32Array(LIGHT_SIZE * LIGHT_SIZE),
      lightPhi: new Float32Array(LIGHT_SIZE * LIGHT_SIZE * VIG_TERMS),
      thumb: new Float32Array(THUMB_SIZE * THUMB_SIZE),
      thumbOk: new Uint8Array(THUMB_SIZE * THUMB_SIZE),
      counts: null,
    }
    this.tiles.set(key(tx, ty), tile)
    return tile
  }

  private touch(t: Tile): void {
    const k = key(t.tx, t.ty)
    this.dirty.add(k)
    this.thumbDirty.add(k)
    t.counts = null
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

  /** Pixel counts by confidence class (cached per tile). */
  stats(): MapStats {
    const out: MapStats = { covered: 0, weak: 0, soft: 0 }
    for (const t of this.tiles.values()) {
      if (!t.counts) {
        let covered = 0
        let weak = 0
        let soft = 0
        const q = t.q
        for (let i = 0; i < TILE_PIXELS; i++) {
          const v = q[i]
          if (v === 0) continue
          covered++
          if (v < WEAK_Q) weak++
          else if (v < SHARP_Q) soft++
        }
        t.counts = { covered, weak, soft }
      }
      out.covered += t.counts.covered
      out.weak += t.counts.weak
      out.soft += t.counts.soft
    }
    return out
  }

  /**
   * Confidence of a tile on a CONF_SIZE² grid: 0 = (mostly) empty, otherwise the mean
   * stored quality of the cell (1..255). Compare against WEAK_Q / SHARP_Q.
   */
  confidence(t: Tile, out: Uint8Array): void {
    const q = t.q
    for (let cy = 0; cy < CONF_SIZE; cy++) {
      for (let cx = 0; cx < CONF_SIZE; cx++) {
        let sum = 0
        let n = 0
        for (let y = cy * CONF_CELL; y < (cy + 1) * CONF_CELL; y++) {
          const row = y * TILE_SIZE
          for (let x = cx * CONF_CELL; x < (cx + 1) * CONF_CELL; x++) {
            const v = q[row + x]
            if (v === 0) continue
            sum += v
            n++
          }
        }
        out[cy * CONF_SIZE + cx] = n * 2 > CONF_CELL * CONF_CELL ? Math.max(1, Math.round(sum / n)) : 0
      }
    }
  }

  /**
   * Marks a world rectangle as untrustworthy: it keeps its picture, but any other look
   * at it replaces it. Used when something written there turns out to have been HUD.
   */
  demote(x0: number, y0: number, w: number, h: number): void {
    for (let ty = y0 >> TILE_SHIFT; ty <= (y0 + h - 1) >> TILE_SHIFT; ty++) {
      for (let tx = x0 >> TILE_SHIFT; tx <= (x0 + w - 1) >> TILE_SHIFT; tx++) {
        const t = this.getTile(tx, ty)
        if (!t) continue
        const xa = Math.max(x0, tx * TILE_SIZE)
        const xb = Math.min(x0 + w, (tx + 1) * TILE_SIZE)
        const ya = Math.max(y0, ty * TILE_SIZE)
        const yb = Math.min(y0 + h, (ty + 1) * TILE_SIZE)
        let touched = false
        for (let wy = ya; wy < yb; wy++) {
          const row = (wy & TILE_MASK) * TILE_SIZE
          for (let wx = xa; wx < xb; wx++) {
            const i = row + (wx & TILE_MASK)
            if (t.q[i] > 1) {
              t.q[i] = 1
              t.n[i] = 1
              touched = true
            }
          }
        }
        if (touched) this.touch(t)
      }
    }
  }

  /**
   * How many of the frame's usable pixels (sampled every `step` px) the map has no
   * data for. Cheap test for "would this frame fill a hole?".
   */
  countMissing(x0: number, y0: number, w: number, h: number, q: Uint8Array, step = 16): number {
    let missing = 0
    let cacheKey = -1
    let tile: Tile | undefined
    for (let y = step >> 1; y < h; y += step) {
      const wy = y0 + y
      for (let x = step >> 1; x < w; x += step) {
        if (q[y * w + x] === 0) continue
        const wx = x0 + x
        const k = key(wx >> TILE_SHIFT, wy >> TILE_SHIFT)
        if (k !== cacheKey) {
          cacheKey = k
          tile = this.tiles.get(k)
        }
        if (!tile || tile.q[(wy & TILE_MASK) * TILE_SIZE + (wx & TILE_MASK)] === 0) missing++
      }
    }
    return missing
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
    const shade = new Uint16Array(n)
    const lum = new Uint8Array(n)
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
          if (q[i] === 0) {
            any = true
            continue
          }
          col[i] = t!.raw32[ti]
          shade[i] = t!.shade[ti]
          lum[i] = t!.lum[ti]
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
            t.raw32[ti] = 0xff000000 | (bl << 16) | (g << 8) | r
            // Interpolating colour and shade together keeps the lighting ratio of both ends.
            t.shade[ti] = Math.max(1, Math.round(shade[start - 1] * (1 - f) + shade[end] * f))
            t.lum[ti] = Math.round(lum[start - 1] * (1 - f) + lum[end] * f)
            t.q[ti] = 1
            t.n[ti] = 1
            this.touch(t)
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
      if (t) this.updateThumb(t)
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
   * Copies (lighting-normalised) luma and quality of a world rectangle into contiguous
   * buffers. Missing tiles read as q = 0.
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

  /** Lighting-layer value of the cell containing world pixel (wx, wy); 0 = not observed. */
  lightAt(wx: number, wy: number): number {
    const t = this.getTile(wx >> TILE_SHIFT, wy >> TILE_SHIFT)
    if (!t) return 0
    const li = (((wy & TILE_MASK) >> LIGHT_SHIFT) * LIGHT_SIZE) + ((wx & TILE_MASK) >> LIGHT_SHIFT)
    return t.lightW[li] > 0.05 ? this.cellLight(t, li) : 0
  }

  // ---- rendering

  private pad = new Float32Array(PAD * PAD)
  private padTmp = new Float32Array(PAD * PAD)
  private lightRow = new Float32Array(PAD)

  /** Lighting cells of `t` plus a one-cell border from the neighbouring tiles; 0 = unknown. */
  private gatherLight(t: Tile): Float32Array {
    const { pad, padTmp } = this
    pad.fill(0)
    let unknown = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nb = dx === 0 && dy === 0 ? t : this.getTile(t.tx + dx, t.ty + dy)
        if (!nb) continue
        // Cells of `nb` that fall inside the padded window of `t`.
        const cx0 = dx < 0 ? LIGHT_SIZE - 1 : 0
        const cx1 = dx > 0 ? 0 : LIGHT_SIZE - 1
        const cy0 = dy < 0 ? LIGHT_SIZE - 1 : 0
        const cy1 = dy > 0 ? 0 : LIGHT_SIZE - 1
        for (let cy = cy0; cy <= cy1; cy++) {
          const src = cy * LIGHT_SIZE
          const dst = (cy + dy * LIGHT_SIZE + 1) * PAD + dx * LIGHT_SIZE + 1
          for (let cx = cx0; cx <= cx1; cx++) pad[dst + cx] = this.cellLight(nb, src + cx)
        }
      }
    }
    for (let i = 0; i < PAD * PAD; i++) if (pad[i] === 0) unknown++
    // Grow known lighting into unknown cells (never observed, e.g. inpainted gaps).
    for (let iter = 0; iter < 3 && unknown > 0 && unknown < PAD * PAD; iter++) {
      padTmp.set(pad)
      for (let y = 0; y < PAD; y++) {
        for (let x = 0; x < PAD; x++) {
          const i = y * PAD + x
          if (padTmp[i] !== 0) continue
          let sum = 0
          let n = 0
          for (let yy = Math.max(0, y - 1); yy <= Math.min(PAD - 1, y + 1); yy++) {
            for (let xx = Math.max(0, x - 1); xx <= Math.min(PAD - 1, x + 1); xx++) {
              const v = padTmp[yy * PAD + xx]
              if (v !== 0) {
                sum += v
                n++
              }
            }
          }
          if (n > 0) {
            pad[i] = sum / n
            unknown--
          }
        }
      }
    }
    return pad
  }

  /**
   * Renders a tile to displayable RGBA (little-endian words, alpha 0 where empty):
   * the captured colour of every pixel, re-lit with the shared lighting layer.
   */
  renderTile(t: Tile, out: Uint32Array): void {
    const { raw32, shade, q } = t
    if (!this.blendLighting) {
      for (let i = 0; i < TILE_PIXELS; i++) out[i] = q[i] === 0 ? 0 : raw32[i] | 0xff000000
      return
    }
    const pad = this.gatherLight(t)
    const row = this.lightRow
    const invShade = 1 / SHADE_ONE
    for (let y = 0; y < TILE_SIZE; y++) {
      const r0 = LIGHT_IDX[y] * PAD
      const r1 = r0 + PAD
      const fy = LIGHT_FRAC[y]
      for (let c = 0; c < PAD; c++) {
        const a = pad[r0 + c]
        const b = pad[r1 + c]
        row[c] = a > 0 && b > 0 ? a + (b - a) * fy : a > 0 ? a : b
      }
      const o = y * TILE_SIZE
      for (let x = 0; x < TILE_SIZE; x++) {
        const i = o + x
        if (q[i] === 0) {
          out[i] = 0
          continue
        }
        const c0 = LIGHT_IDX[x]
        const a = row[c0]
        const b = row[c0 + 1]
        const light = a > 0 && b > 0 ? a + (b - a) * LIGHT_FRAC[x] : a > 0 ? a : b
        const p = raw32[i]
        if (light <= 0) {
          out[i] = p | 0xff000000
          continue
        }
        let ratio = (light + RATIO_SOFT) / (shade[i] * invShade + RATIO_SOFT)
        if (ratio < RATIO_MIN) ratio = RATIO_MIN
        else if (ratio > RATIO_MAX) ratio = RATIO_MAX
        let r = ((p & 0xff) * ratio + 0.5) | 0
        let g = (((p >>> 8) & 0xff) * ratio + 0.5) | 0
        let bl = (((p >>> 16) & 0xff) * ratio + 0.5) | 0
        if (r > 255) r = 255
        if (g > 255) g = 255
        if (bl > 255) bl = 255
        out[i] = 0xff000000 | (bl << 16) | (g << 8) | r
      }
    }
  }

  // ---- compositing

  // Scratch buffers for composite(), sized to the frame.
  private sLum = new Uint8Array(0)
  private sQ = new Uint8Array(0)
  private sN = new Uint8Array(0)
  private fLum = new Uint8Array(0)
  private fScore = new Uint8Array(0)
  private fShade = new Uint16Array(0)
  private cls = new Uint8Array(0)
  private blockConflicts = new Uint16Array(0)
  private blockDiff = new Int32Array(0)
  private blockCount = new Uint16Array(0)
  private blockInvalid = new Uint8Array(0)
  private satDiff = new Float64Array(0)
  private satCount = new Int32Array(0)
  private blockLabel = new Int32Array(0)
  private partLabel = new Int32Array(0)
  private stack = new Int32Array(0)
  private colIdx = new Int32Array(0)
  private colFrac = new Float32Array(0)
  private rowShade = new Float32Array(0)
  private rowWeight = new Float32Array(0)
  private rowFresh = new Float32Array(0)
  private rowNorm = new Float32Array(0)
  private colU = new Float32Array(0)
  private relight = new Float32Array(0)
  private relightW = new Float32Array(0)
  private relightTmp = new Float32Array(0)
  private relightTmp2 = new Float32Array(0)
  private rowRelight = new Float32Array(0)
  /** Normalised luma of the last fully composited frame (0 = unusable) and where it was. */
  private prevLum = new Uint8Array(0)
  private prevX = 0
  private prevY = 0
  private prevW = 0
  private prevH = 0
  /**
   * The last composited frame before `prev` that was taken from another position than
   * `prev`: while the camera rests, `prev` is the same view as the frame at hand and
   * this is the nearest independent look.
   */
  private pastLum = new Uint8Array(0)
  private pastX = 0
  private pastY = 0
  private pastW = 0
  private pastH = 0

  /**
   * Writes a frame into the map.
   *
   * The map has two layers. The **detail** layer keeps, per pixel, the best single
   * observation (raw colour plus how bright that frame was around it). The
   * **lighting** layer is a smooth, low-resolution average of every frame's local
   * brightness. The picture is detail ÷ its own frame's brightness × the shared
   * lighting, so frames taken under different lighting (cloud shadows, vignette) join
   * without brightness steps, and no chained gain estimate can drift.
   *
   * Detail is one sample per pixel, chosen seam-aware:
   * 1. Each frame pixel is classified against the map: NEW (map empty), AGREE, or
   *    CONFLICT. Brightness is compared lighting-normalised, and a pixel only conflicts
   *    if its surroundings differ on average too: the same content seen sharper,
   *    blurrier or a pixel off is not a conflict.
   * 2. Conflicting pixels are grouped into blobs on a BLOCK grid (grown so a blob
   *    covers the whole object and its blur halo). A blob is taken entirely from the
   *    frame or kept entirely from the map, so an animated machine is never stitched
   *    together from two moments. Blobs too big or stringy to be one object (belt
   *    networks) are decided part by part instead: every item on a belt is one part.
   * 3. The frame gets a blob (or, outside blobs, a pixel) only when it is clearly the
   *    better look: sharper (a still frame beats a moving one), more settled, further
   *    from the frame edge. An equally good frame changes nothing, so the map doesn't
   *    churn while the camera pans over animated parts.
   * 4. What is stored only loses standing when two frames from different camera
   *    positions agree with each other, to the grey level, against it: a cursor or
   *    tooltip that sat on the screen during a stop is thrown out, and content that
   *    really changed loses its confirmations. Animated parts never qualify.
   * 5. Where frame and map agree, the switch to the better look is feathered.
   */
  composite(f: CompositeInput): CompositeResult {
    const { rgba32, lum, q, width: W, height: H, x: fx0, y: fy0 } = f
    const n = W * H
    if (this.sLum.length < n) {
      this.sLum = new Uint8Array(n)
      this.sQ = new Uint8Array(n)
      this.sN = new Uint8Array(n)
      this.fLum = new Uint8Array(n)
      this.prevLum = new Uint8Array(n)
      this.prevW = 0
      this.pastW = 0
      this.fScore = new Uint8Array(n)
      this.fShade = new Uint16Array(n)
      this.cls = new Uint8Array(n)
    }
    const bw = Math.ceil(W / BLOCK)
    const bh = Math.ceil(H / BLOCK)
    const nb = bw * bh
    if (this.blockConflicts.length < nb) {
      this.blockConflicts = new Uint16Array(nb)
      this.blockDiff = new Int32Array(nb)
      this.blockCount = new Uint16Array(nb)
      this.blockInvalid = new Uint8Array(nb)
      this.blockLabel = new Int32Array(nb)
      this.partLabel = new Int32Array(nb)
      this.stack = new Int32Array(nb)
    }
    const { shade, shadeW: sw, shadeH: sh, shadeScale: ss } = f
    if (this.colIdx.length < W) {
      this.colIdx = new Int32Array(W)
      this.colFrac = new Float32Array(W)
    }
    if (this.rowShade.length < sw + 1) {
      this.rowShade = new Float32Array(sw + 1)
      this.rowWeight = new Float32Array(sw + 1)
      this.rowFresh = new Float32Array(sw + 1)
      this.rowNorm = new Float32Array(sw + 1)
    }
    const { sLum, sQ, sN, fLum, fScore, fShade, cls, blockConflicts, blockInvalid, blockLabel, stack } = this
    const { colIdx, colFrac, rowShade, rowFresh, rowNorm, blockDiff, blockCount } = this
    const fresh = f.fresh
    for (let x = 0; x < W; x++) {
      const u = Math.max(0, Math.min(sw - 1, (x + 0.5) / ss - 0.5))
      const x0 = Math.floor(u)
      colIdx[x] = x0
      colFrac[x] = u - x0
    }
    const fillOnly = f.mode === 'fill'
    const assemble = f.assemble === true
    const switchLead = assemble ? ASSEMBLE_LEAD : SWITCH_LEAD
    const featherLo = assemble ? 0 : FEATHER_LO
    const featherHi = assemble ? ASSEMBLE_FEATHER : FEATHER_HI
    const result: CompositeResult = { written: 0, filled: 0, overlap: 0, conflicts: 0 }

    this.extract(fx0, fy0, W, H, sLum, sQ, sN)

    // ---- 1. classify
    blockConflicts.fill(0, 0, nb)
    blockInvalid.fill(0, 0, nb)
    blockDiff.fill(0, 0, nb)
    blockCount.fill(0, 0, nb)
    const sf = Math.max(0.05, Math.min(1, f.speedFactor))
    let candidates = 0
    for (let y = 0; y < H; y++) {
      const row = y * W
      const brow = (y >> BLOCK_SHIFT) * bw
      const v = Math.max(0, Math.min(sh - 1, (y + 0.5) / ss - 0.5))
      const y0 = Math.floor(v)
      const fy = v - y0
      const s0 = y0 * sw
      const s1 = Math.min(sh - 1, y0 + 1) * sw
      for (let c = 0; c < sw; c++) {
        const shd = shade[s0 + c] + (shade[s1 + c] - shade[s0 + c]) * fy
        rowShade[c] = shd * SHADE_ONE
        // Normalisation gain per cell, interpolated per pixel: saves a division per pixel.
        rowNorm[c] = NORM_LEVEL / (shd > NORM_FLOOR ? shd : NORM_FLOOR)
        rowFresh[c] = fresh ? (fresh[s0 + c] + (fresh[s1 + c] - fresh[s0 + c]) * fy) * sf : sf
      }
      rowShade[sw] = rowShade[sw - 1]
      rowNorm[sw] = rowNorm[sw - 1]
      rowFresh[sw] = rowFresh[sw - 1]
      for (let x = 0; x < W; x++) {
        const i = row + x
        const fq = q[i]
        if (fq === 0) {
          cls[i] = SKIP
          fLum[i] = 0 // "no data", for the next frame's witness lookup
          blockInvalid[brow + (x >> BLOCK_SHIFT)] = 1
          continue
        }
        const c0 = colIdx[x]
        const fr = colFrac[x]
        const fs = (fq * (rowFresh[c0] + (rowFresh[c0 + 1] - rowFresh[c0]) * fr)) | 0
        fScore[i] = fs > 0 ? fs : 1
        const s16 = (rowShade[c0] + (rowShade[c0 + 1] - rowShade[c0]) * fr + 0.5) | 0
        fShade[i] = s16 < 1 ? 1 : s16 > 65535 ? 65535 : s16
        let fl = (lum[i] * (rowNorm[c0] + (rowNorm[c0 + 1] - rowNorm[c0]) * fr) + 0.5) | 0
        if (fl > 255) fl = 255
        else if (fl < 1) fl = 1
        fLum[i] = fl
        if (sQ[i] === 0) {
          cls[i] = NEW
        } else {
          result.overlap++
          // Difference in real brightness (64ths of a grey level): the normalised
          // difference times how bright it is here. Judged on normalised luma alone,
          // every bit of noise in dark machinery would count as a conflict.
          const d = (((fl - sLum[i]) * (s16 > SHADE_FLOOR ? s16 : SHADE_FLOOR)) / NORM_LEVEL) | 0
          const b = brow + (x >> BLOCK_SHIFT)
          blockDiff[b] += d
          blockCount[b]++
          if (d > CONFLICT_DIFF * SHADE_ONE || d < -CONFLICT_DIFF * SHADE_ONE) {
            cls[i] = CONFLICT // provisional, see below
            candidates++
          } else {
            cls[i] = AGREE
          }
        }
      }
    }
    // A differing pixel is only a conflict if its surroundings differ too. Motion blur
    // and a pixel of misalignment move brightness around locally but keep the local
    // mean; a different object (an icon, a cursor, an item on a belt) changes it.
    // The surroundings are the (2·MEAN_RADIUS+1)² blocks around the pixel's block,
    // about 20×20 pixels: wide enough that a pixel of misalignment across a hard edge
    // (frames are placed to whole pixels) stays below the threshold.
    if (candidates > 0 && !fillOnly && assemble) {
      // Stills are sharp and may differ by parallax, which keeps the local mean just as
      // blur does: here every differing pixel counts.
      for (let y = 0; y < H; y++) {
        const row = y * W
        const brow = (y >> BLOCK_SHIFT) * bw
        for (let x = 0; x < W; x++) {
          if (cls[row + x] !== CONFLICT) continue
          result.conflicts++
          blockConflicts[brow + (x >> BLOCK_SHIFT)]++
        }
      }
    } else if (candidates > 0 && !fillOnly) {
      // Summed-area tables over the blocks, so any window costs four lookups.
      const iw = bw + 1
      const need = iw * (bh + 1)
      if (this.satDiff.length < need) {
        this.satDiff = new Float64Array(need)
        this.satCount = new Int32Array(need)
      }
      const { satDiff, satCount } = this
      satDiff.fill(0, 0, iw)
      satCount.fill(0, 0, iw)
      for (let by = 0; by < bh; by++) {
        let rowDiff = 0
        let rowCount = 0
        const o = (by + 1) * iw
        satDiff[o] = 0
        satCount[o] = 0
        for (let bx = 0; bx < bw; bx++) {
          rowDiff += blockDiff[by * bw + bx]
          rowCount += blockCount[by * bw + bx]
          satDiff[o + bx + 1] = satDiff[o - iw + bx + 1] + rowDiff
          satCount[o + bx + 1] = satCount[o - iw + bx + 1] + rowCount
        }
      }
      const limit = CONFLICT_MEAN_DIFF * SHADE_ONE
      for (let y = 0; y < H; y++) {
        const row = y * W
        const by = y >> BLOCK_SHIFT
        const brow = by * bw
        const top = Math.max(0, by - MEAN_RADIUS) * iw
        const bottom = Math.min(bh, by + MEAN_RADIUS + 1) * iw
        for (let x = 0; x < W; x++) {
          const i = row + x
          if (cls[i] !== CONFLICT) continue
          const bx = x >> BLOCK_SHIFT
          const left = Math.max(0, bx - MEAN_RADIUS)
          const right = Math.min(bw, bx + MEAN_RADIUS + 1)
          const diff = satDiff[bottom + right] - satDiff[bottom + left] - satDiff[top + right] + satDiff[top + left]
          const cnt = satCount[bottom + right] - satCount[bottom + left] - satCount[top + right] + satCount[top + left]
          if (diff > limit * cnt || diff < -limit * cnt) {
            result.conflicts++
            blockConflicts[brow + bx]++
          } else {
            cls[i] = AGREE
          }
        }
      }
    }
    // The frame border counts as invalid too: objects there are cut off.
    for (let bx = 0; bx < bw; bx++) blockInvalid[bx] = blockInvalid[(bh - 1) * bw + bx] = 1
    for (let by = 0; by < bh; by++) blockInvalid[by * bw] = blockInvalid[by * bw + bw - 1] = 1

    // ---- 2. conflict blobs: blocks with >= 2 conflicting pixels, grown by BLOB_GROW blocks
    let blobs = 0
    blockLabel.fill(0, 0, nb)
    if (result.conflicts > 0) {
      for (let b = 0; b < nb; b++) {
        if (blockConflicts[b] < 2) continue
        const bx = b % bw
        const by = (b / bw) | 0
        for (let dy = -BLOB_GROW; dy <= BLOB_GROW; dy++) {
          const yy = by + dy
          if (yy < 0 || yy >= bh) continue
          for (let dx = -BLOB_GROW; dx <= BLOB_GROW; dx++) {
            const xx = bx + dx
            if (xx >= 0 && xx < bw) blockLabel[yy * bw + xx] = -1 // in a blob, not labelled yet
          }
        }
      }
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
    }

    // ---- 3. decide per blob
    const prev = this.prevLum
    const hasPrev = !fillOnly && !assemble && this.prevW === W && this.prevH === H
    const pdx = fx0 - this.prevX // frame pixel (x, y) is previous-frame pixel (x + pdx, y + pdy)
    const pdy = fy0 - this.prevY
    // The previous frame is a second, independent look only if the camera moved in
    // between: two frames from one camera position share everything that is fixed to
    // the screen (the cursor, a tooltip, icons the game hides near the screen edge).
    const independent = hasPrev && (pdx !== 0 || pdy !== 0)
    // A look from elsewhere, for small objects only this frame shows: the previous
    // frame if the camera moved, else the one from before it stopped.
    const hasPast = !fillOnly && !assemble && this.pastW === W && this.pastH === H
    const other = independent ? prev : hasPrev && hasPast ? this.pastLum : null
    const odx = independent ? pdx : fx0 - this.pastX
    const ody = independent ? pdy : fy0 - this.pastY
    const witnessMin = WITNESS_ZONE * 255 * sf
    // Agreement only confirms from a decent part of the frame: at the frame edge and
    // in what has just scrolled in, frames agree with each other about missing icons.
    const confirmMin = CONFIRM_ZONE * 255 * sf
    // A frame cannot discredit a sharper sample than it could deliver itself: blurry
    // frames panning past never wear down what a still frame captured.
    const frameTop = 255 * sf + 8
    // takeFrame: 0 = keep the map's version, 1 = take the frame's, 2 = not one object: decide per pixel
    const takeFrame = new Uint8Array(blobs + 1)
    // weaken: 1 = the stored version loses a confirmation, 2 = it is a transient and loses quality
    const weaken = new Uint8Array(blobs + 1)
    // Quality a blob is stored with when it is taken: one value for the whole object.
    // A frame usually sees an object partly in its core and partly in its margin; with
    // per-pixel quality the next frame would then replace only the weaker half.
    const blobQ = new Uint8Array(blobs + 1)
    if (blobs > 0) {
      const sumF = new Float64Array(blobs + 1) // frame quality over the conflicting pixels
      const sumM = new Float64Array(blobs + 1) // stored quality over the conflicting pixels
      const conflicting = new Float64Array(blobs + 1)
      const sumN = new Float64Array(blobs + 1) // confirmations of the stored conflicting pixels
      const exact = new Float64Array(blobs + 1) // conflicting pixels the previous frame saw exactly like this one
      const backed = new Float64Array(blobs + 1) // conflicting pixels a frame from elsewhere saw exactly like the map
      const area = new Float64Array(blobs + 1)
      const sumFAll = new Float64Array(blobs + 1) // frame quality over all of the blob's pixels
      const invalid = new Uint8Array(blobs + 1)
      const minBx = new Int32Array(blobs + 1).fill(bw)
      const maxBx = new Int32Array(blobs + 1).fill(-1)
      const minBy = new Int32Array(blobs + 1).fill(bh)
      const maxBy = new Int32Array(blobs + 1).fill(-1)
      for (let b = 0; b < nb; b++) {
        const label = blockLabel[b]
        if (label <= 0) continue
        if (blockInvalid[b]) invalid[label] = 1
        const bx = b % bw
        const by = (b / bw) | 0
        if (bx < minBx[label]) minBx[label] = bx
        if (bx > maxBx[label]) maxBx[label] = bx
        if (by < minBy[label]) minBy[label] = by
        if (by > maxBy[label]) maxBy[label] = by
        const x0 = bx << BLOCK_SHIFT
        const y0 = by << BLOCK_SHIFT
        const x1 = Math.min(W, x0 + BLOCK)
        const y1 = Math.min(H, y0 + BLOCK)
        for (let y = y0; y < y1; y++) {
          const row = y * W
          const py = y + pdy
          const prow = independent && py >= 0 && py < H ? py * W + pdx : -1
          const oy = y + ody
          const orow = other !== null && oy >= 0 && oy < H ? oy * W + odx : -1
          for (let x = x0; x < x1; x++) {
            const i = row + x
            const c = cls[i]
            if (c !== AGREE && c !== CONFLICT) continue
            area[label]++
            sumFAll[label] += fScore[i]
            if (c !== CONFLICT) continue
            conflicting[label]++
            sumF[label] += fScore[i]
            sumM[label] += sQ[i]
            const stored = sN[i] || 1
            sumN[label] += stored
            // Against confirmed content only the best part of a frame may testify;
            // against content nobody ever confirmed, any decent pixel may.
            if (prow >= 0 && fScore[i] >= (stored > 1 ? witnessMin : TRANSIENT_MIN_Q)) {
              const px = x + pdx
              if (px >= 0 && px < W) {
                const p = prev[prow + x]
                const sh = fShade[i] > SHADE_FLOOR ? fShade[i] : SHADE_FLOOR
                if (p !== 0 && Math.abs(fLum[i] - p) * sh <= TRANSIENT_DIFF * SHADE_ONE * NORM_LEVEL) exact[label]++
              }
            }
            if (orow >= 0) {
              const ox = x + odx
              if (ox >= 0 && ox < W) {
                const p = other![orow + x]
                const sh = fShade[i] > SHADE_FLOOR ? fShade[i] : SHADE_FLOOR
                if (p !== 0 && Math.abs(sLum[i] - p) * sh <= TRANSIENT_DIFF * SHADE_ONE * NORM_LEVEL) backed[label]++
              }
            }
          }
        }
      }
      const maxBlob = Math.max(MAX_BLOB_FRACTION * W * H, 128 * 128)
      for (let k = 1; k <= blobs; k++) {
        const n = conflicting[k]
        if (n === 0) {
          takeFrame[k] = 2
          continue
        }
        blobQ[k] = Math.max(1, Math.round(sumFAll[k] / area[k]))
        // Two independent looks that agree with each other to the grey level, against
        // the map: what the map shows there is gone (or never was part of the world).
        // Animated parts never qualify; no two frames show them exactly alike.
        if (exact[k] >= TRANSIENT_SHARE * n) {
          if (sumN[k] < 1.5 * n && area[k] <= TRANSIENT_MAX_AREA) {
            // Small and never confirmed: something that sat on the screen (the cursor,
            // a tooltip) while the camera stood still. Out with it, even if it is sharper.
            ;(result.transients ??= []).push({
              x: fx0 + minBx[k] * BLOCK,
              y: fy0 + minBy[k] * BLOCK,
              w: (maxBx[k] - minBx[k] + 1) * BLOCK,
              h: (maxBy[k] - minBy[k] + 1) * BLOCK,
            })
            if (!invalid[k] && sumF[k] >= TRANSIENT_TAKE * sumM[k]) {
              takeFrame[k] = 1
              continue
            }
            weaken[k] = 2
          } else if (sumM[k] <= frameTop * n) {
            weaken[k] = 1
          }
        }
        const bboxW = (maxBx[k] - minBx[k] + 1) * BLOCK
        const bboxH = (maxBy[k] - minBy[k] + 1) * BLOCK
        const compact = Math.max(bboxW, bboxH) <= OBJECT_MAX_SIDE && area[k] >= 0.25 * bboxW * bboxH
        if (assemble) {
          // One object: whole, from whichever view rates it higher. Anything else: per pixel.
          takeFrame[k] = area[k] > maxBlob || !compact ? 2 : sumF[k] >= sumM[k] + switchLead * n ? 1 : 0
        } else if (area[k] > maxBlob || (invalid[k] && !compact)) {
          // Too large or too stringy to be one object (a belt network): no all-or-nothing
          // choice. Each pixel switches when the frame is clearly better there.
          takeFrame[k] = 2
        } else if (invalid[k]) {
          // An object cut off by the frame edge or the HUD: half of it would come from
          // this moment and half from another. Only take it if what is stored is poor.
          takeFrame[k] = sumM[k] < 0.25 * sumF[k] ? 1 : 0
        } else if (sumN[k] >= 2 * n && sumM[k] >= SETTLED_Q * n) {
          // Settled content (see SETTLED_Q) is not up for grabs.
          takeFrame[k] = 0
        } else {
          // The whole object comes from one frame, and the frame only gets it when it is
          // clearly the better look. An equally good one never replaces what is there:
          // animated parts keep their one sample.
          takeFrame[k] = sumF[k] >= sumM[k] + SWITCH_LEAD * n ? 1 : 0
        }
        if (
          !assemble &&
          takeFrame[k] === 0 &&
          !invalid[k] &&
          compact &&
          area[k] <= TRANSIENT_MAX_AREA &&
          backed[k] >= TRANSIENT_SHARE * n
        ) {
          ;(result.contradicted ??= []).push({
            x: fx0 + minBx[k] * BLOCK,
            y: fy0 + minBy[k] * BLOCK,
            w: bboxW,
            h: bboxH,
          })
        }
      }
    }

    // ---- 3b. blobs that are not one object (belt networks, pipes), part by part
    // A part is a connected patch of conflicting blocks: an item on a belt, or two
    // positions of it that overlap. Each part, with the halo around it, is taken from
    // the frame or kept from the map as a whole, by the same rule as an object. Seams
    // then run between the items on a belt, not through them.
    const partLabel = this.partLabel
    let parts = 0
    let takePart: Uint8Array | null = null
    let partQ: Uint8Array | null = null
    if (blobs > 0 && !assemble) {
      partLabel.fill(0, 0, nb)
      for (let b = 0; b < nb; b++) {
        if (partLabel[b] !== 0 || blockConflicts[b] < 2 || takeFrame[blockLabel[b]] !== 2) continue
        parts++
        let sp = 0
        stack[sp++] = b
        partLabel[b] = parts
        while (sp > 0) {
          const c = stack[--sp]
          const cx = c % bw
          const cy = (c / bw) | 0
          for (let yy = Math.max(0, cy - 1); yy <= Math.min(bh - 1, cy + 1); yy++) {
            for (let xx = Math.max(0, cx - 1); xx <= Math.min(bw - 1, cx + 1); xx++) {
              const o = yy * bw + xx
              if (partLabel[o] !== 0 || blockConflicts[o] < 2 || takeFrame[blockLabel[o]] !== 2) continue
              partLabel[o] = parts
              stack[sp++] = o
            }
          }
        }
      }
    }
    if (parts > 0) {
      // The halo: blocks of the blob around a part belong to the nearest part. (Stored
      // negative while searching, so only real parts spread.)
      for (let b = 0; b < nb; b++) {
        if (partLabel[b] !== 0 || blockLabel[b] <= 0 || takeFrame[blockLabel[b]] !== 2) continue
        const bx = b % bw
        const by = (b / bw) | 0
        let best = 0
        let bestD = 99
        for (let yy = Math.max(0, by - BLOB_GROW); yy <= Math.min(bh - 1, by + BLOB_GROW); yy++) {
          for (let xx = Math.max(0, bx - BLOB_GROW); xx <= Math.min(bw - 1, bx + BLOB_GROW); xx++) {
            const l = partLabel[yy * bw + xx]
            if (l <= 0) continue
            const d = Math.abs(xx - bx) + Math.abs(yy - by)
            if (d < bestD) {
              bestD = d
              best = l
            }
          }
        }
        if (best > 0) partLabel[b] = -best
      }
      const pF = new Float64Array(parts + 1)
      const pM = new Float64Array(parts + 1)
      const pN = new Float64Array(parts + 1)
      const pConf = new Float64Array(parts + 1)
      const pAll = new Float64Array(parts + 1)
      const pArea = new Float64Array(parts + 1)
      const pInvalid = new Uint8Array(parts + 1)
      for (let b = 0; b < nb; b++) {
        const l = partLabel[b]
        if (l === 0) continue
        const part = l < 0 ? -l : l
        if (blockInvalid[b]) pInvalid[part] = 1
        const x0 = (b % bw) << BLOCK_SHIFT
        const y0 = ((b / bw) | 0) << BLOCK_SHIFT
        const x1 = Math.min(W, x0 + BLOCK)
        const y1 = Math.min(H, y0 + BLOCK)
        for (let y = y0; y < y1; y++) {
          for (let i = y * W + x0; i < y * W + x1; i++) {
            const c = cls[i]
            if (c !== AGREE && c !== CONFLICT) continue
            pArea[part]++
            pAll[part] += fScore[i]
            if (c !== CONFLICT) continue
            pConf[part]++
            pF[part] += fScore[i]
            pM[part] += sQ[i]
            pN[part] += sN[i] || 1
          }
        }
      }
      takePart = new Uint8Array(parts + 1)
      partQ = new Uint8Array(parts + 1)
      for (let k = 1; k <= parts; k++) {
        const n = pConf[k]
        if (n === 0) continue
        partQ[k] = Math.max(1, Math.round(pAll[k] / pArea[k]))
        if (pInvalid[k]) takePart[k] = pM[k] < 0.25 * pF[k] ? 1 : 0
        else if (pN[k] >= 2 * n && pM[k] >= SETTLED_Q * n) takePart[k] = 0
        else takePart[k] = pF[k] >= pM[k] + SWITCH_LEAD * n ? 1 : 0
      }
    }

    // ---- 4. write
    const confirm = f.confirm
    const own = assemble ? null : (f.own ?? null)
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
          const tOff = (wy & TILE_MASK) * TILE_SIZE - (wx0 & ~TILE_MASK)
          for (let wx = wx0; wx < wx1; wx++) {
            const fi = fOff + wx
            const c = cls[fi]
            if (c === SKIP) continue
            const ti = tOff + wx
            if (c === NEW) {
              if (!t) t = this.createTile(tx, ty)
              t.raw32[ti] = rgba32[fi] | 0xff000000
              t.shade[ti] = fShade[fi]
              t.lum[ti] = fLum[fi]
              t.q[ti] = fScore[fi]
              t.n[ti] = 1
              if (own !== null) own[fi] = 1
              result.filled++
              result.written++
              touched = true
              continue
            }
            if (fillOnly || !t) continue
            // alpha: 0 = keep the stored pixel … 256 = replace it
            let alpha = 0
            const nn = sN[fi] || 1
            let newN = nn
            const block = brow + ((wx - fx0) >> BLOCK_SHIFT)
            const label = blockLabel[block]
            let take = label > 0 ? takeFrame[label] : 2
            let wholeQ = blobQ[label]
            if (take === 2 && takePart !== null) {
              const l = partLabel[block]
              if (l !== 0) {
                const part = l < 0 ? -l : l
                take = takePart[part]
                wholeQ = partQ![part]
              }
            }
            const confirms = confirm && nn < N_MAX && fScore[fi] >= confirmMin
            if (take === 1) {
              alpha = 256
              newN = c === AGREE ? (confirms ? nn + 1 : nn) : 1
            } else {
              const lead = fScore[fi] - sQ[fi]
              // A lone differing pixel (no blob) is noise, not an object: it goes
              // wherever its agreeing neighbours go, or it would be left behind as a speck.
              if (c === AGREE || label === 0) {
                if (confirms && c === AGREE) newN = nn + 1
                // Same content, better look: switch over, feathered across a narrow band
                // of quality lead (which is a narrow strip along the seam on the map).
                if (take === 2 && lead > featherLo) {
                  alpha = lead >= featherHi ? 256 : Math.max(1, (((lead - featherLo) << 8) / (featherHi - featherLo)) | 0)
                }
              } else if (take === 2 && lead >= switchLead && !(nn >= 2 && sQ[fi] >= SETTLED_Q)) {
                // Different content and no object to keep whole: never mix the two.
                alpha = 256
                newN = 1
              } else if (weaken[label] === 2) {
                if (nn <= 1) {
                  t.q[ti] = Math.max(1, sQ[fi] >> 1)
                  touched = true
                }
              } else if (weaken[label] === 1 && nn > 1) {
                newN = nn - 1
              }
            }
            if (own !== null && (alpha > 0 || own[fi] !== 0)) {
              // One stop, one picture (see CompositeInput.own).
              if (alpha !== 256) {
                alpha = 256
                if (c !== AGREE) newN = 1
              }
              own[fi] = 1
            }
            if (alpha === 256) {
              t.raw32[ti] = rgba32[fi] | 0xff000000
              t.shade[ti] = fShade[fi]
              t.lum[ti] = fLum[fi]
              t.q[ti] = take === 1 ? wholeQ : fScore[fi]
              result.written++
              touched = true
            } else if (alpha > 0) {
              // Colour and shade are mixed together, so the result still divides out to
              // a consistent lighting-free colour.
              const p = rgba32[fi]
              const o = t.raw32[ti]
              const or = o & 0xff
              const og = (o >>> 8) & 0xff
              const ob = (o >>> 16) & 0xff
              const r = or + ((((p & 0xff) - or) * alpha) >> 8)
              const g = og + (((((p >>> 8) & 0xff) - og) * alpha) >> 8)
              const b = ob + (((((p >>> 16) & 0xff) - ob) * alpha) >> 8)
              t.raw32[ti] = 0xff000000 | (b << 16) | (g << 8) | r
              const os = t.shade[ti]
              t.shade[ti] = os + (((fShade[fi] - os) * alpha) >> 8)
              const ol = sLum[fi]
              t.lum[ti] = ol + (((fLum[fi] - ol) * alpha) >> 8)
              const oq = sQ[fi]
              t.q[ti] = oq + Math.max(1, ((fScore[fi] - oq) * alpha) >> 8)
              result.written++
              touched = true
            }
            if (newN !== sN[fi]) t.n[ti] = newN
          }
        }
        if (touched && t) this.touch(t)
      }
    }

    if (!fillOnly) {
      // This frame becomes the next one's witness: swap the buffers instead of copying.
      // If the camera moved, the frame before stays on as the look from elsewhere.
      if (this.prevW === W && this.prevH === H && (this.prevX !== fx0 || this.prevY !== fy0)) {
        const spare = this.pastLum.length >= n ? this.pastLum : new Uint8Array(n)
        this.pastLum = this.prevLum
        this.pastX = this.prevX
        this.pastY = this.prevY
        this.pastW = W
        this.pastH = H
        this.prevLum = spare
      }
      this.fLum = this.prevLum
      this.prevLum = fLum
      this.prevX = fx0
      this.prevY = fy0
      this.prevW = W
      this.prevH = H
    }

    if (!f.skipLight) this.updateLight(f)
    return result
  }

  // ---- assembling stills

  private aRaw = new Uint32Array(0)
  private aShade = new Uint16Array(0)
  private fRate = new Uint8Array(0)
  private bSum = new Float32Array(0)
  private bLead = new Int32Array(0)
  private bCnt = new Uint16Array(0)
  private bNew = new Uint16Array(0)
  private bState = new Int32Array(0)
  private cut = new MinCut()

  /**
   * Gets the map ready for assemble(): every pixel gets a rating to compete with.
   * What is on the map (put together while capturing) counts as much as a still does
   * at the rim of its core if it was captured mid-screen, and next to nothing if it
   * was only ever seen at a screen edge.
   */
  prepareAssembly(): void {
    for (const t of this.tiles.values()) {
      const { q, n } = t
      for (let i = 0; i < TILE_PIXELS; i++) {
        n[i] = q[i] === 0 ? 0 : q[i] >= CAPTURE_CORE_Q ? RATING_CAPTURE_CORE : RATING_CAPTURE_EDGE
      }
    }
    this.prevW = 0
    this.pastW = 0
  }

  /**
   * Ends an assembly: ratings go, the map is an ordinary capture map again.
   * @returns pixels that no still took over (still as captured)
   */
  finishAssembly(): number {
    let kept = 0
    for (const t of this.tiles.values()) {
      const { q, n } = t
      for (let i = 0; i < TILE_PIXELS; i++) {
        if (q[i] === 0) continue
        if (n[i] === RATING_CAPTURE_CORE || n[i] === RATING_CAPTURE_EDGE) kept++
        n[i] = 1
      }
    }
    this.prevW = 0
    this.pastW = 0
    return kept
  }

  /** Copies the detail of a world rectangle into contiguous buffers; missing tiles read as q = 0. */
  private extractDetail(
    x0: number,
    y0: number,
    w: number,
    h: number,
    outRaw: Uint32Array,
    outShade: Uint16Array,
    outQ: Uint8Array,
    outN: Uint8Array,
  ): void {
    outQ.fill(0, 0, w * h)
    for (let ty = y0 >> TILE_SHIFT; ty <= (y0 + h - 1) >> TILE_SHIFT; ty++) {
      for (let tx = x0 >> TILE_SHIFT; tx <= (x0 + w - 1) >> TILE_SHIFT; tx++) {
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
          outRaw.set(t.raw32.subarray(src, src + span), dst)
          outShade.set(t.shade.subarray(src, src + span), dst)
          outQ.set(t.q.subarray(src, src + span), dst)
          outN.set(t.n.subarray(src, src + span), dst)
        }
      }
    }
  }

  /**
   * Joins a still frame (a camera stop, or a screenshot) to what is already assembled.
   * Call prepareAssembly() first and finishAssembly() after the last still.
   *
   * Stills are sharp and each is consistent in itself; the trouble is where two meet.
   * The game's camera has perspective, so raised things (pipes, belts, floating icons)
   * sit a few pixels apart in two views of the same ground. A border drawn straight
   * through the overlap slices whatever lies on it: a belt it runs along comes out
   * with its two halves shifted, a machine it crosses has a step in it.
   *
   * So the border is routed instead. The overlap is divided into BLOCK-sized cells and
   * each cell goes to the still or stays as it is, such that the total of
   *   - how much the two views differ along the border between the two kinds of cells
   *     (a border through ground they agree on is free and invisible; one through a
   *     belt, an icon or a moving item is expensive), and
   *   - a mild preference for the view that has the cell nearer its middle
   * is as small as it can be (a minimum cut, see MinCut). The border then runs through
   * grass and along the edges of things, and where it has to cross a belt or pipe it
   * does so where the two views happen to match: where the belt runs in the direction
   * the camera moved between the two stops, the shift is along the belt and nothing
   * shows. Cells where one view is clearly the better one are not up for discussion,
   * which keeps the problem small.
   *
   * `suspects` are places where the capture found that something had only sat on the
   * screen while this still was taken (CompositeResult.transients). Where the still
   * really differs from the map there, the map keeps what it has.
   */
  assemble(f: CompositeInput & { rating: Uint8Array; suspects?: ReadonlyArray<WorldBox> }): CompositeResult {
    const { rgba32, lum, q, rating, width: W, height: H, x: fx0, y: fy0 } = f
    const n = W * H
    if (this.sLum.length < n) {
      this.sLum = new Uint8Array(n)
      this.sQ = new Uint8Array(n)
      this.sN = new Uint8Array(n)
      this.fLum = new Uint8Array(n)
      this.prevLum = new Uint8Array(n)
      this.fScore = new Uint8Array(n)
      this.fShade = new Uint16Array(n)
      this.cls = new Uint8Array(n)
    }
    if (this.aRaw.length < n) {
      this.aRaw = new Uint32Array(n)
      this.aShade = new Uint16Array(n)
      this.fRate = new Uint8Array(n)
    }
    const bw = Math.ceil(W / BLOCK)
    const bh = Math.ceil(H / BLOCK)
    const nb = bw * bh
    if (this.bSum.length < nb) {
      this.bSum = new Float32Array(nb)
      this.bLead = new Int32Array(nb)
      this.bCnt = new Uint16Array(nb)
      this.bNew = new Uint16Array(nb)
      this.bState = new Int32Array(nb)
    }
    const { shade, shadeW: sw, shadeH: sh, shadeScale: ss, fresh } = f
    if (this.colIdx.length < W) {
      this.colIdx = new Int32Array(W)
      this.colFrac = new Float32Array(W)
    }
    if (this.rowShade.length < sw + 1) {
      this.rowShade = new Float32Array(sw + 1)
      this.rowWeight = new Float32Array(sw + 1)
      this.rowFresh = new Float32Array(sw + 1)
      this.rowNorm = new Float32Array(sw + 1)
    }
    const { sQ, sN, fLum, fScore, fShade, fRate, cls, aRaw, aShade, bSum, bLead, bCnt, bNew, bState } = this
    const { colIdx, colFrac, rowShade, rowFresh, rowNorm } = this
    for (let x = 0; x < W; x++) {
      const u = Math.max(0, Math.min(sw - 1, (x + 0.5) / ss - 0.5))
      const x0 = Math.floor(u)
      colIdx[x] = x0
      colFrac[x] = u - x0
    }
    const result: CompositeResult = { written: 0, filled: 0, overlap: 0, conflicts: 0 }
    this.extractDetail(fx0, fy0, W, H, aRaw, aShade, sQ, sN)

    // ---- 1. per pixel: what the still offers, and how much it differs from the map
    bSum.fill(0, 0, nb)
    bLead.fill(0, 0, nb)
    bCnt.fill(0, 0, nb)
    bNew.fill(0, 0, nb)
    const sf = Math.max(0.05, Math.min(1, f.speedFactor))
    for (let y = 0; y < H; y++) {
      const row = y * W
      const brow = (y >> BLOCK_SHIFT) * bw
      const v = Math.max(0, Math.min(sh - 1, (y + 0.5) / ss - 0.5))
      const y0 = Math.floor(v)
      const fy = v - y0
      const s0 = y0 * sw
      const s1 = Math.min(sh - 1, y0 + 1) * sw
      for (let c = 0; c < sw; c++) {
        const shd = shade[s0 + c] + (shade[s1 + c] - shade[s0 + c]) * fy
        rowShade[c] = shd * SHADE_ONE
        rowNorm[c] = NORM_LEVEL / (shd > NORM_FLOOR ? shd : NORM_FLOOR)
        rowFresh[c] = fresh ? fresh[s0 + c] + (fresh[s1 + c] - fresh[s0 + c]) * fy : 1
      }
      rowShade[sw] = rowShade[sw - 1]
      rowNorm[sw] = rowNorm[sw - 1]
      rowFresh[sw] = rowFresh[sw - 1]
      for (let x = 0; x < W; x++) {
        const i = row + x
        const fq = q[i]
        if (fq === 0) {
          cls[i] = SKIP
          continue
        }
        const c0 = colIdx[x]
        const fr = colFrac[x]
        // How settled the content is (icons pop in a moment after scrolling into view).
        const settled = rowFresh[c0] + (rowFresh[c0 + 1] - rowFresh[c0]) * fr
        const fs = (fq * settled * sf) | 0
        fScore[i] = fs > 0 ? fs : 1
        // A slightly soft still (the camera had only just stopped) loses to a crisp
        // one, but its core is still a still's core: `sf` only scales what is above
        // the rim. Content that hasn't settled may lack its icons: that scales all of it.
        let rate = rating[i]
        if (rate >= RATING_CORE) rate = RATING_CORE + (rate - RATING_CORE) * sf
        // Not settled: rated just below anything captured mid-screen, so that such
        // content wins, but not so far below that the border is nailed to the line
        // where settled content ends (a straight line across whatever is there).
        if (settled < 0.98 && rate > RATING_UNSETTLED) rate = RATING_UNSETTLED
        rate |= 0
        if (rate < 1) rate = 1
        // (Two values are taken: they mark what was there before the assembly.)
        else if (rate === RATING_CAPTURE_CORE || rate === RATING_CAPTURE_EDGE) rate++
        fRate[i] = rate
        const s16 = (rowShade[c0] + (rowShade[c0 + 1] - rowShade[c0]) * fr + 0.5) | 0
        fShade[i] = s16 < 1 ? 1 : s16 > 65535 ? 65535 : s16
        let fl = (lum[i] * (rowNorm[c0] + (rowNorm[c0 + 1] - rowNorm[c0]) * fr) + 0.5) | 0
        if (fl > 255) fl = 255
        else if (fl < 1) fl = 1
        fLum[i] = fl
        const b = brow + (x >> BLOCK_SHIFT)
        if (sQ[i] === 0) {
          cls[i] = NEW
          bNew[b]++
          continue
        }
        cls[i] = AGREE
        result.overlap++
        // The map's colour as it would look under this still's lighting, against the still's.
        let ratio = fShade[i] / (aShade[i] || 1)
        if (ratio < 0.5) ratio = 0.5
        else if (ratio > 2) ratio = 2
        const p = rgba32[i]
        const m = aRaw[i]
        let d = (p & 0xff) - (m & 0xff) * ratio
        if (d < 0) d = -d
        let e = ((p >>> 8) & 0xff) - ((m >>> 8) & 0xff) * ratio
        if (e < 0) e = -e
        if (e > d) d = e
        e = ((p >>> 16) & 0xff) - ((m >>> 16) & 0xff) * ratio
        if (e < 0) e = -e
        if (e > d) d = e
        if (d > CONFLICT_DIFF) result.conflicts++
        bSum[b] += d
        bCnt[b]++
        bLead[b] += rate - sN[i]
      }
    }

    // ---- 2. which cells are up for discussion
    // bState: ≥ 0 = node of the cut, TAKE / KEEP = decided.
    let nodes = 0
    for (let b = 0; b < nb; b++) {
      const cnt = bCnt[b]
      if (cnt === 0) {
        bState[b] = bNew[b] > 0 ? TAKE : KEEP
        continue
      }
      const lead = bLead[b] / cnt
      // How much the two views differ here, beyond what noise accounts for.
      const diff = bSum[b] / cnt - SEAM_NOISE
      bSum[b] = diff <= 0 ? 0 : diff > SEAM_MAX_DIFF ? SEAM_MAX_DIFF : diff
      bState[b] = lead > SEAM_BAND ? TAKE : lead < -SEAM_BAND ? KEEP : -3
    }
    for (const s of f.suspects ?? []) {
      const bx0 = Math.max(0, ((s.x - fx0) >> BLOCK_SHIFT) - SUSPECT_GROW)
      const by0 = Math.max(0, ((s.y - fy0) >> BLOCK_SHIFT) - SUSPECT_GROW)
      const bx1 = Math.min(bw, ((s.x + s.w - fx0 + BLOCK - 1) >> BLOCK_SHIFT) + SUSPECT_GROW)
      const by1 = Math.min(bh, ((s.y + s.h - fy0 + BLOCK - 1) >> BLOCK_SHIFT) + SUSPECT_GROW)
      let differing = 0
      for (let by = by0; by < by1; by++) {
        for (let bx = bx0; bx < bx1; bx++) if (bCnt[by * bw + bx] > 0 && bSum[by * bw + bx] >= SUSPECT_DIFF) differing++
      }
      if (differing < SUSPECT_CELLS) continue
      for (let by = by0; by < by1; by++) {
        for (let bx = bx0; bx < bx1; bx++) if (bCnt[by * bw + bx] > 0) bState[by * bw + bx] = KEEP
      }
    }
    for (let b = 0; b < nb; b++) if (bState[b] === -3) bState[b] = nodes++

    // ---- 3. the cheapest border
    const cut = this.cut
    if (nodes > 0) {
      cut.reset(nodes)
      const { capS, capT } = cut
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const b = by * bw + bx
          const id = bState[b]
          if (id < 0) continue
          const cnt = bCnt[b]
          const lead = bLead[b] / cnt
          // Preference for the better-rated view, and for not splitting a cell that
          // the still has to fill part of anyway.
          if (lead > 0) capS[id] += Math.round(SEAM_PULL * lead * cnt)
          else capT[id] += Math.round(-SEAM_PULL * lead * cnt)
          capS[id] += SEAM_NEW * bNew[b]
          const own = bSum[b]
          // Left and up: only decided neighbours (links between nodes are made from the other side).
          const sides = [
            bx + 1 < bw ? b + 1 : -1,
            bx > 0 ? b - 1 : -1,
            by + 1 < bh ? b + bw : -1,
            by > 0 ? b - bw : -1,
          ]
          for (let d = 0; d < 4; d++) {
            const o = sides[d]
            // Beyond the frame there is only the map.
            const state = o < 0 ? KEEP : bState[o]
            const other = o < 0 || bCnt[o] === 0 ? own : bSum[o]
            const w = Math.round(SEAM_SCALE * (SEAM_LENGTH + (own + other) / 2))
            if (state === TAKE) capS[id] += w
            else if (state === KEEP) capT[id] += w
            else if (d === 0 || d === 2) cut.link(id, state, d, w)
          }
        }
      }
      cut.solve()
      // How good a border was there to be had? (For diagnostics and tests.)
      let seam = 0
      let bad = 0
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const b = by * bw + bx
          const a = bState[b]
          const mine = a === TAKE || (a >= 0 && cut.onSourceSide(a))
          for (let d = 0; d < 2; d++) {
            const o = d === 0 ? (bx + 1 < bw ? b + 1 : -1) : by + 1 < bh ? b + bw : -1
            if (o < 0) continue
            const c = bState[o]
            if (mine === (c === TAKE || (c >= 0 && cut.onSourceSide(c)))) continue
            // Only where both sides have something to compare.
            if (bCnt[b] === 0 || bCnt[o] === 0) continue
            seam += BLOCK
            if ((bSum[b] + bSum[o]) / 2 > SEAM_VISIBLE) bad += BLOCK
          }
        }
      }
      result.seamLength = seam
      result.seamThroughConflict = bad
    }

    // ---- 4. write
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
          const tOff = (wy & TILE_MASK) * TILE_SIZE - (wx0 & ~TILE_MASK)
          for (let wx = wx0; wx < wx1; wx++) {
            const fi = fOff + wx
            const c = cls[fi]
            if (c === SKIP) continue
            if (c === NEW) {
              result.filled++
            } else {
              const state = bState[brow + ((wx - fx0) >> BLOCK_SHIFT)]
              if (state === KEEP || (state >= 0 && !cut.onSourceSide(state))) continue
            }
            if (!t) t = this.createTile(tx, ty)
            const ti = tOff + wx
            t.raw32[ti] = rgba32[fi] | 0xff000000
            t.shade[ti] = fShade[fi]
            t.lum[ti] = fLum[fi]
            t.q[ti] = fScore[fi]
            t.n[ti] = fRate[fi]
            result.written++
            touched = true
          }
        }
        if (touched && t) this.touch(t)
      }
    }
    this.prevW = 0
    this.pastW = 0
    if (!f.skipLight) this.updateLight(f)
    return result
  }

  /**
   * Folds the frame's local brightness into the lighting layer, and what the frame
   * says about the vignette into the vignette estimate.
   */
  private updateLight(f: CompositeInput): void {
    const { x: fx0, y: fy0, width: W, height: H, shade, shadeWeight, shadeW: sw, shadeH: sh, shadeScale: ss } = f
    const K = VIG_TERMS
    const lightScale = f.lightScale ?? 1
    // Every cell whose centre is inside the frame, plus a ring of one cell: pixels at
    // the frame edge interpolate between the cells on both sides.
    const cx0 = (fx0 - LIGHT_CELL) >> LIGHT_SHIFT
    const cx1 = (fx0 + W + LIGHT_CELL - 1) >> LIGHT_SHIFT
    const cy0 = (fy0 - LIGHT_CELL) >> LIGHT_SHIFT
    const cy1 = (fy0 + H + LIGHT_CELL - 1) >> LIGHT_SHIFT
    const ncx = cx1 - cx0 + 1
    if (this.colIdx.length < ncx) {
      this.colIdx = new Int32Array(ncx)
      this.colFrac = new Float32Array(ncx)
    }
    if (this.colU.length < ncx) this.colU = new Float32Array(ncx)
    // Vignette samples: [weight, y, z_0..z_K-1] per sampled cell (see below).
    const stride = K + 2
    const maxSamples = (cy1 - cy0 + 1) * ncx
    if (this.vigSamples.length < maxSamples * stride) this.vigSamples = new Float32Array(maxSamples * stride)
    const { colIdx, colFrac, colU, rowShade, rowWeight, vigSamples } = this
    let ns = 0
    const half = LIGHT_CELL / 2
    const relight = this.relightField(f)
    if (this.rowRelight.length < sw + 1) this.rowRelight = new Float32Array(sw + 1)
    const rowRelight = this.rowRelight
    for (let k = 0; k < ncx; k++) {
      const px = (cx0 + k) * LIGHT_CELL + half - fx0 // frame coordinate of the cell centre
      const u = Math.max(0, Math.min(sw - 1, px / ss - 0.5))
      const x0 = Math.floor(u)
      colIdx[k] = x0
      colFrac[k] = u - x0
      colU[k] = (Math.max(0, Math.min(W, px)) / W) * 2 - 1
    }
    const phi = new Float64Array(K)
    const tileShift = TILE_SHIFT - LIGHT_SHIFT
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = cy * LIGHT_CELL + half - fy0
      const v = Math.max(0, Math.min(sh - 1, py / ss - 0.5))
      const y0 = Math.floor(v)
      const fy = v - y0
      const s0 = y0 * sw
      const s1 = Math.min(sh - 1, y0 + 1) * sw
      for (let c = 0; c < sw; c++) {
        rowShade[c] = shade[s0 + c] + (shade[s1 + c] - shade[s0 + c]) * fy
        rowWeight[c] = shadeWeight[s0 + c] + (shadeWeight[s1 + c] - shadeWeight[s0 + c]) * fy
      }
      rowShade[sw] = rowShade[sw - 1]
      rowWeight[sw] = rowWeight[sw - 1]
      if (relight) {
        for (let c = 0; c < sw; c++) rowRelight[c] = relight[s0 + c] + (relight[s1 + c] - relight[s0 + c]) * fy
        rowRelight[sw] = rowRelight[sw - 1]
      }
      const rowInside = py >= 0 && py < H
      const sv = (Math.max(0, Math.min(H, py)) / H) * 2 - 1
      const v2 = sv * sv
      const ty = cy >> tileShift
      const lrow = (cy & LIGHT_MASK) * LIGHT_SIZE
      let tile: Tile | undefined
      let tileTx = NaN
      for (let k = 0; k < ncx; k++) {
        const cx = cx0 + k
        const tx = cx >> tileShift
        if (tx !== tileTx) {
          tileTx = tx
          tile = this.getTile(tx, ty)
          if (tile) this.touch(tile)
        }
        if (!tile) continue
        const c0 = colIdx[k]
        const fr = colFrac[k]
        const value = Math.log(rowShade[c0] + (rowShade[c0 + 1] - rowShade[c0]) * fr)
        let weight = (rowWeight[c0] + (rowWeight[c0 + 1] - rowWeight[c0]) * fr) * lightScale
        const px = cx * LIGHT_CELL + half - fx0
        const real = rowInside && px >= 0 && px < W && weight >= LIGHT_EPS
        if (!real) weight = LIGHT_EPS
        const su = colU[k]
        const u2 = su * su
        phi[0] = u2
        phi[1] = v2
        phi[2] = u2 * u2
        phi[3] = v2 * v2
        phi[4] = u2 * v2
        phi[5] = su
        phi[6] = sv
        const li = lrow + (cx & LIGHT_MASK)
        const po = li * K
        const w0 = tile.lightW[li]
        if (w0 === 0) {
          tile.light[li] = value
          tile.lightW[li] = weight
          for (let j = 0; j < K; j++) tile.lightPhi[po + j] = phi[j]
          continue
        }
        // What this cell looked like from other screen positions vs. now: the
        // difference in brightness that goes with the difference in screen position
        // is the vignette. (Every fourth cell is plenty.)
        if (real && weight > 0.05 && w0 > 0.2 && (cx & 1) === 0 && (cy & 1) === 0) {
          const o = ns * stride
          // sqrt: the vignette shows near the frame edges, exactly where lighting weights are small.
          vigSamples[o] = Math.sqrt(weight) * Math.min(1, w0)
          vigSamples[o + 1] = value - tile.light[li]
          for (let j = 0; j < K; j++) vigSamples[o + 2 + j] = phi[j] - tile.lightPhi[po + j]
          ns++
        }
        // Cloud shadows: bring the frame up to the map where it is darker, and the
        // map up towards the frame where the frame is brighter. Sunlit wins, so the
        // map settles on even lighting instead of a patchwork of passing shadows.
        let lit = value
        if (relight) {
          const g = rowRelight[c0] + (rowRelight[c0 + 1] - rowRelight[c0]) * fr
          if (g < 0) lit -= g
          else if (g > RELIGHT_DEADBAND && real) {
            const share = RELIGHT_RAISE * (rowWeight[c0] + (rowWeight[c0 + 1] - rowWeight[c0]) * fr)
            tile.light[li] += (g - RELIGHT_DEADBAND) * share
          }
        }
        const wn = w0 + weight
        const a = weight / wn
        tile.light[li] += (lit - tile.light[li]) * a
        for (let j = 0; j < K; j++) tile.lightPhi[po + j] += (phi[j] - tile.lightPhi[po + j]) * a
        tile.lightW[li] = wn > LIGHT_CAP ? LIGHT_CAP : wn
      }
    }
    if (ns >= 200 && this.learnVignette) this.observeVignette(ns)
  }

  /**
   * How much brighter (+) or darker (−) the frame is than the map at large scale, in
   * log units on the frame's shade grid: the frame's vignette-free brightness minus the
   * lighting layer's, blurred wide. null when the frame barely overlaps the map.
   */
  private relightField(f: CompositeInput): Float32Array | null {
    const { x: fx0, y: fy0, width: W, height: H, shade, shadeWeight, shadeW: sw, shadeH: sh, shadeScale: ss } = f
    const n = sw * sh
    if (this.relight.length < n) {
      this.relight = new Float32Array(n)
      this.relightW = new Float32Array(n)
      this.relightTmp = new Float32Array(n)
      this.relightTmp2 = new Float32Array(n)
    }
    const { relight: num, relightW: den, relightTmp: tmp, relightTmp2: acc } = this
    const th = this.vignette
    const K = VIG_TERMS
    let total = 0
    let sum = 0
    let sumW = 0
    for (let cy = 0; cy < sh; cy++) {
      const py = cy * ss + (ss >> 1)
      const wy = fy0 + py
      const sv = (py / H) * 2 - 1
      const v2 = sv * sv
      let tile: Tile | undefined
      let tileTx = NaN
      for (let cx = 0; cx < sw; cx++) {
        const i = cy * sw + cx
        num[i] = 0
        den[i] = 0
        const fw = shadeWeight[i]
        if (fw <= 0.02) continue
        total++
        const px = cx * ss + (ss >> 1)
        const wx = fx0 + px
        const tx = wx >> TILE_SHIFT
        if (tx !== tileTx) {
          tileTx = tx
          tile = this.getTile(tx, wy >> TILE_SHIFT)
        }
        if (!tile) continue
        const li = ((wy & TILE_MASK) >> LIGHT_SHIFT) * LIGHT_SIZE + ((wx & TILE_MASK) >> LIGHT_SHIFT)
        const w0 = tile.lightW[li]
        if (w0 < RELIGHT_MIN_WEIGHT) continue
        const su = (px / W) * 2 - 1
        const u2 = su * su
        const po = li * K
        const phi = tile.lightPhi
        // (frame − its vignette) − (map − the vignette of the views it was built from)
        let r =
          Math.log(shade[i]) -
          tile.light[li] -
          (th[0] * (u2 - phi[po]) +
            th[1] * (v2 - phi[po + 1]) +
            th[2] * (u2 * u2 - phi[po + 2]) +
            th[3] * (v2 * v2 - phi[po + 3]) +
            th[4] * (u2 * v2 - phi[po + 4]) +
            th[5] * (su - phi[po + 5]) +
            th[6] * (sv - phi[po + 6]))
        // Local differences (an animation, a HUD leftover) are not lighting.
        if (r > 0.5) r = 0.5
        else if (r < -0.5) r = -0.5
        const w = Math.sqrt(fw)
        num[i] = r * w
        den[i] = w
        sum += r * w
        sumW += w
      }
    }
    if (sumW < 0.1 * total) return null
    const radius = Math.max(2, Math.round(RELIGHT_RADIUS * sw))
    boxSum(num, sw, sh, radius, acc, tmp)
    boxSum(acc, sw, sh, radius, num, tmp)
    boxSum(den, sw, sh, radius, acc, tmp)
    boxSum(acc, sw, sh, radius, den, tmp)
    // Far from any overlap (the newly revealed strip), fall back on the frame-wide mean.
    const mean = sum / sumW
    const support = (2 * radius + 1) * (2 * radius + 1) * 4
    for (let i = 0; i < n; i++) {
      const d = den[i]
      const t = d >= support ? 1 : d / support
      num[i] = d > 0 ? (num[i] / d) * t + mean * (1 - t) : mean
    }
    return num
  }

  /**
   * Least squares for θ in  Δbrightness ≈ θ · Δbasis + (this frame's overall lighting),
   * over the samples gathered by updateLight(). Accumulates across frames.
   */
  private observeVignette(ns: number): void {
    const K = VIG_TERMS
    const stride = K + 2
    const s = this.vigSamples
    const th = this.vignette
    const mean = new Float64Array(K + 1) // [y, z...]
    let wsum = 0
    for (let i = 0; i < ns; i++) {
      const o = i * stride
      const w = s[o]
      wsum += w
      for (let j = 0; j <= K; j++) mean[j] += w * s[o + 1 + j]
    }
    if (wsum <= 0) return
    for (let j = 0; j <= K; j++) mean[j] /= wsum
    const z = new Float64Array(K)
    const { vigM, vigB } = this
    for (let i = 0; i < ns; i++) {
      const o = i * stride
      const y = s[o + 1] - mean[0]
      let pred = 0
      for (let j = 0; j < K; j++) {
        z[j] = s[o + 2 + j] - mean[1 + j]
        pred += th[j] * z[j]
      }
      // Huber weight: animation and stray HUD pixels shouldn't steer the estimate.
      const e = Math.abs(y - pred)
      const w = s[o] * (e > 0.15 ? 0.15 / e : 1)
      for (let a = 0; a < K; a++) {
        const wa = w * z[a]
        vigB[a] += wa * y
        for (let b = a; b < K; b++) vigM[a * K + b] += wa * z[b]
      }
    }
    if (++this.vigFrames % VIG_SOLVE_EVERY === 0) this.solveVignette()
  }

  private solveVignette(): void {
    const K = VIG_TERMS
    // (M + λI) θ = b + λ θ₀, by Gaussian elimination with partial pivoting.
    const a = new Float64Array(K * (K + 1))
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) a[i * (K + 1) + j] = i <= j ? this.vigM[i * K + j] : this.vigM[j * K + i]
      const prior = i >= 5 ? VIG_PRIOR_WEIGHT_LINEAR : VIG_PRIOR_WEIGHT
      a[i * (K + 1) + i] += prior
      a[i * (K + 1) + K] = this.vigB[i] + prior * ENDFIELD_VIGNETTE[i]
    }
    for (let c = 0; c < K; c++) {
      let p = c
      for (let r = c + 1; r < K; r++) if (Math.abs(a[r * (K + 1) + c]) > Math.abs(a[p * (K + 1) + c])) p = r
      if (Math.abs(a[p * (K + 1) + c]) < 1e-9) return
      if (p !== c) {
        for (let j = 0; j <= K; j++) {
          const t = a[c * (K + 1) + j]
          a[c * (K + 1) + j] = a[p * (K + 1) + j]
          a[p * (K + 1) + j] = t
        }
      }
      for (let r = 0; r < K; r++) {
        if (r === c) continue
        const m = a[r * (K + 1) + c] / a[c * (K + 1) + c]
        if (m === 0) continue
        for (let j = c; j <= K; j++) a[r * (K + 1) + j] -= m * a[c * (K + 1) + j]
      }
    }
    // Biggest change in log brightness anywhere on screen (|basis terms| ≤ 1).
    let change = 0
    const next = new Float64Array(K)
    for (let i = 0; i < K; i++) {
      next[i] = a[i * (K + 1) + K] / a[i * (K + 1) + i]
      if (!Number.isFinite(next[i])) return
      change += Math.abs(next[i] - this.vignette[i])
    }
    this.vignette.set(next)
    // The lighting of every tile depends on θ: redraw them all if it moved visibly.
    if (change > VIG_REDRAW) for (const t of this.tiles.values()) this.touch(t)
  }

  /** Thumbnail = block means of the tile's displayed luma (normalised luma × lighting). */
  private updateThumb(t: Tile): void {
    const S = THUMB_SCALE
    const { lum, q } = t
    const cells = new Float32Array(LIGHT_SIZE * LIGHT_SIZE)
    for (let i = 0; i < cells.length; i++) cells[i] = this.cellLight(t, i) || NORM_LEVEL
    for (let by = 0; by < THUMB_SIZE; by++) {
      for (let bx = 0; bx < THUMB_SIZE; bx++) {
        let sum = 0
        let n = 0
        for (let y = by * S; y < (by + 1) * S; y++) {
          const row = y * TILE_SIZE
          const lrow = (y >> LIGHT_SHIFT) * LIGHT_SIZE
          for (let x = bx * S; x < (bx + 1) * S; x++) {
            if (q[row + x] === 0) continue
            sum += lum[row + x] * cells[lrow + (x >> LIGHT_SHIFT)]
            n++
          }
        }
        const i = by * THUMB_SIZE + bx
        t.thumb[i] = n > 0 ? sum / n / NORM_LEVEL : 0
        t.thumbOk[i] = n > (S * S * 3) / 4 ? 1 : 0
      }
    }
  }
}
