import { dilate, erode } from './image'

/**
 * How much better one explanation must fit than the other before it counts as
 * evidence: this many grey levels, or this fraction of the pixel's brightness if that
 * is more (whatever screen-fixed shading is left scales with brightness).
 */
const MARGIN = 8
const MARGIN_RELATIVE = 0.1
/** Step towards "HUD" per piece of evidence (three in a row cross the threshold). */
const HUD_RATE = 0.25
/** Step towards "world". Slower: a HUD element never moves, so one odd frame mustn't unmask it. */
const WORLD_RATE = 0.15
/**
 * A pixel that both explanations fit says little, but not nothing. If it did not
 * change at all on screen while the camera moved (within STATIC_EPS grey levels), it
 * leans towards HUD: that is what the inside of a flat panel looks like. If it changed
 * (by more than CHANGED_EPS), it leans towards world. Both pulls are weak, so real
 * evidence always wins: it takes about 14 static frames in a row to mask a pixel.
 */
const STATIC_EPS = 1.5
const STATIC_RATE = 0.05
const CHANGED_EPS = 4
const CHANGED_RATE = 0.1
/** Contrast to a neighbour (grey levels) from which a pixel of a still image counts as textured. */
const STILL_CONTRAST = 6
/**
 * Difference (grey levels) between two still images from which a pixel counts as
 * changed. A little above zero so that lossy screenshots (JPEG) still work.
 */
const STILL_CHANGED = 6
/**
 * How far apart (as a share of the distance between the two camera positions) the two
 * views of a raised object may be. Measured in Endfield: pipes 1.2 %, facility icons 1.5 %.
 */
const PARALLAX_REACH = 0.02
/** Smallest group of pixels (mask scale) that is taken for a piece of HUD in still images. */
const STILL_MIN_GROUP = 12
const MASK_ON = 0.5
/** A masked pixel stays masked until its score falls below this (hysteresis). */
const MASK_OFF = 0.2

/**
 * Learns which screen pixels belong to the HUD.
 *
 * When the camera pans by `d`, a world pixel moves with it and a HUD pixel stays put.
 * For every pixel two explanations are compared:
 *   - screen-fixed: cur(p) ≈ prev(p)
 *   - world-fixed:  cur(p) ≈ prev(p − d)  or  cur(p + d) ≈ prev(p)
 * Whichever fits clearly better gets a strong vote. A pixel both fit (a flat area, an
 * edge parallel to the pan) only gets a weak one, see STATIC_EPS. So translucent
 * panels and thin text are caught quickly, flat panels a little later, and
 * featureless ground or dark corners only if they are perfectly still for a second.
 *
 * Both world tests are needed: next to a HUD element one of them compares against
 * the HUD itself and fails, which would otherwise stamp a ghost of the HUD into the
 * mask, displaced by the pan.
 */
export class UiMaskEstimator {
  readonly w: number
  readonly h: number
  /** Number of frames with enough motion that contributed votes. */
  observations = 0
  private score: Float32Array
  private tmp: Uint8Array
  private tmp2: Uint8Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.score = new Float32Array(w * h)
    this.tmp = new Uint8Array(w * h)
    this.tmp2 = new Uint8Array(w * h)
  }

  reset(): void {
    this.score.fill(0)
    this.prevMask?.fill(0)
    this.observations = 0
  }

  /**
   * @param cur current frame (grayscale, mask scale, vignette removed: a vignette makes
   *   the world change brightness as it scrolls, which would look like HUD)
   * @param prev previous frame, likewise
   * @param dx,dy integer content shift in mask-scale pixels: cur(p) ≈ prev(p − d)
   */
  observe(cur: Float32Array, prev: Float32Array, dx: number, dy: number): void {
    const { w, h, score } = this
    for (let y = 0; y < h; y++) {
      const by = y - dy // where this pixel's content was in the previous frame
      const fy = y + dy // where the previous frame's content at this pixel is now
      const backRow = by >= 0 && by < h
      const fwdRow = fy >= 0 && fy < h
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const c = cur[i]
        const p = prev[i]
        const fixed = Math.abs(c - p)
        // Best world-fixed fit; a side that falls outside the frame can't testify.
        let moved = Infinity
        const bx = x - dx
        if (backRow && bx >= 0 && bx < w) moved = Math.abs(c - prev[by * w + bx])
        const fx = x + dx
        if (fwdRow && fx >= 0 && fx < w) {
          const m = Math.abs(cur[fy * w + fx] - p)
          if (m < moved) moved = m
        }
        if (moved === Infinity) continue
        const rel = (c > p ? c : p) * MARGIN_RELATIVE
        const margin = rel > MARGIN ? rel : MARGIN
        if (moved > fixed + margin) score[i] += HUD_RATE * (1 - score[i])
        else if (fixed > moved + margin) score[i] += WORLD_RATE * (-1 - score[i])
        else if (fixed <= STATIC_EPS) score[i] += STATIC_RATE * (1 - score[i])
        else if (fixed > CHANGED_EPS) score[i] += CHANGED_RATE * (-1 - score[i])
      }
    }
    this.observations++
  }

  /** Writes 1 for UI pixels, 0 otherwise. */
  computeMask(out: Uint8Array): void {
    const { w, h, score, tmp, tmp2 } = this
    for (let i = 0; i < w * h; i++) tmp2[i] = score[i] > MASK_ON ? 1 : 0
    cleanMask(tmp2, out, w, h, tmp)
    // Hysteresis: pixels that were masked stay masked while their score is undecided.
    this.prevMask ??= new Uint8Array(w * h)
    const prevMask = this.prevMask
    for (let i = 0; i < w * h; i++) {
      if (!out[i] && prevMask[i] && score[i] > MASK_OFF) out[i] = 1
    }
    prevMask.set(out)
  }

  private prevMask: Uint8Array | null = null
}

/**
 * Turns raw per-pixel decisions into a mask: drops lone pixels, closes gaps and adds
 * a small margin. `raw` is destroyed.
 */
function cleanMask(raw: Uint8Array, out: Uint8Array, w: number, h: number, tmp: Uint8Array, grow = 4): void {
  const tmp2 = raw
  // Drop lone pixels (noise). A one-pixel-wide stroke of HUD text survives: every
  // pixel of it has two neighbours along the stroke.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!tmp2[i]) {
        out[i] = 0
        continue
      }
      let n = 0
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) n += tmp2[yy * w + xx]
      }
      out[i] = n >= 3 ? 1 : 0
    }
  }
  // Close gaps (letters into words, outlines into filled panels), keeping a small
  // margin so anti-aliased edges and drop shadows are excluded too.
  dilate(out, w, h, grow, tmp)
  erode(out, w, h, 2, tmp)
}

/**
 * Finds the HUD in a set of still images (screenshots) taken at different camera
 * positions, where there is no motion to learn it from.
 *
 * There are only a handful of image pairs, so instead of a running score every pixel
 * collects votes, and the rules are stricter about what counts:
 *
 * - A HUD pixel must be **unchanged on screen in every pair**. This is the test that
 *   matters in a factory laid out on a grid: shift the camera by a whole number of
 *   machines and the same icons land on the same screen positions, but never exactly
 *   (animation, lighting, a pixel of offset). Translucent HUD does change with what is
 *   behind it and is not found this way; the crop margins are for that.
 * - On top of that it needs a positive sign. Where two images overlap in the world:
 *   the pixel differs from the other image's view of the same spot (**HUD** vote),
 *   unless it matches that view and has contrast (**world** vote). Where they do not
 *   overlap: it has contrast, at least twice, and nothing ever voted for world.
 */
export class StillHudVotes {
  readonly w: number
  readonly h: number
  /** Image pairs compared so far. */
  pairs = 0
  private hud: Uint8Array
  private world: Uint8Array
  private changed: Uint8Array
  private still: Uint8Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.hud = new Uint8Array(w * h)
    this.world = new Uint8Array(w * h)
    this.changed = new Uint8Array(w * h)
    this.still = new Uint8Array(w * h)
  }

  /**
   * @param cur one image (grayscale, mask scale, vignette removed)
   * @param other another image, likewise
   * @param shift content shift in mask-scale pixels, cur(p) ≈ other(p − shift); null
   *   while the images have not been placed yet
   */
  observe(cur: Float32Array, other: Float32Array, shift: { dx: number; dy: number } | null): void {
    const { w, h, hud, world, changed, still } = this
    const dx = shift ? shift.dx : 0
    const dy = shift ? shift.dy : 0
    // Raised things (pipes, floating icons) sit a little further along the line between
    // the two camera positions in one view than in the other: the camera has
    // perspective. Before a pixel is taken to contradict the world, look for it there.
    const baseline = Math.hypot(dx, dy)
    const reach = shift ? Math.min(8, Math.ceil(PARALLAX_REACH * baseline) + 1) : 0
    const ux = baseline > 0 ? dx / baseline : 0
    const uy = baseline > 0 ? dy / baseline : 0
    for (let y = 0; y < h; y++) {
      const by = y - dy
      const fy = y + dy
      const backRow = shift !== null && by >= 0 && by < h
      const fwdRow = shift !== null && fy >= 0 && fy < h
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const c = cur[i]
        const p = other[i]
        const fixed = Math.abs(c - p)
        let moved = Infinity
        const bx = x - dx
        if (backRow && bx >= 0 && bx < w) moved = Math.abs(c - other[by * w + bx])
        const fx = x + dx
        if (fwdRow && fx >= 0 && fx < w) {
          const m = Math.abs(cur[fy * w + fx] - p)
          if (m < moved) moved = m
        }
        if (fixed > STILL_CHANGED && changed[i] < 255) changed[i]++
        if (moved !== Infinity) {
          const rel = (c > p ? c : p) * MARGIN_RELATIVE
          const margin = rel > MARGIN ? rel : MARGIN
          if (moved > fixed + margin) {
            for (let t = -reach; t <= reach && moved > fixed + margin; t++) {
              if (t === 0) continue
              const ox = Math.round(t * ux)
              const oy = Math.round(t * uy)
              const qx = x - dx + ox
              const qy = y - dy + oy
              if (qx >= 0 && qx < w && qy >= 0 && qy < h) {
                const m = Math.abs(c - other[qy * w + qx])
                if (m < moved) moved = m
              }
              const rx = x + dx + ox
              const ry = y + dy + oy
              if (rx >= 0 && rx < w && ry >= 0 && ry < h) {
                const m = Math.abs(cur[ry * w + rx] - p)
                if (m < moved) moved = m
              }
            }
          }
          if (moved > fixed + margin) {
            if (hud[i] < 255) hud[i]++
            continue
          }
          if (fixed > moved + margin) {
            if (world[i] < 255) world[i]++
            continue
          }
          if (moved > STILL_CHANGED) continue
        } else if (fixed > STILL_CHANGED) {
          continue
        }
        // Unchanged on screen (no world test), or consistent with the world: either
        // way it only means something where there is contrast.
        let contrast = 0
        if (x > 0) contrast = Math.max(contrast, Math.abs(c - cur[i - 1]))
        if (x < w - 1) contrast = Math.max(contrast, Math.abs(c - cur[i + 1]))
        if (y > 0) contrast = Math.max(contrast, Math.abs(c - cur[i - w]))
        if (y < h - 1) contrast = Math.max(contrast, Math.abs(c - cur[i + w]))
        if (contrast < STILL_CONTRAST) continue
        if (moved !== Infinity) {
          if (world[i] < 255) world[i]++
        } else if (still[i] < 255) {
          still[i]++
        }
      }
    }
    this.pairs++
  }

  /**
   * Writes 1 for every pixel that never changed on screen, positive sign or not, with
   * no clean-up. Too much for drawing (it takes flat ground and chance matches along),
   * but right for matching images against each other: nothing screen-fixed is left to
   * pull an image towards "same place as the last one", and the chance matches only
   * cost a few scattered sample points.
   */
  staticMask(out: Uint8Array): void {
    for (let i = 0; i < out.length; i++) out[i] = this.pairs > 0 && this.changed[i] === 0 ? 1 : 0
  }

  /** Writes 1 for HUD pixels, 0 otherwise. */
  computeMask(out: Uint8Array): void {
    const { w, h, hud, world, changed, still } = this
    const raw = new Uint8Array(w * h)
    if (this.pairs < 2) {
      out.fill(0)
      return
    }
    for (let i = 0; i < w * h; i++) {
      // First of all a HUD pixel never changes on screen, in any pair. Repeated machines
      // only look alike: they differ in animation, lighting and by a pixel or two.
      raw[i] = changed[i] === 0 && (hud[i] > world[i] || (hud[i] === 0 && world[i] === 0 && still[i] >= 2)) ? 1 : 0
    }
    // With so few images a handful of world pixels pass by chance. HUD text and icons
    // come in strokes; a speck of a few pixels on its own is not HUD.
    dropSmallGroups(raw, w, h, STILL_MIN_GROUP, 3)
    // A wider margin than for video: the soft edges and shadows of HUD text do change
    // with what is behind them, so only the solid middle of each stroke was found.
    cleanMask(raw, out, w, h, new Uint8Array(w * h), 6)
  }
}

/**
 * Clears groups of fewer than `min` set pixels. Pixels within `join` of each other
 * count as one group, so the letters of a word stand together.
 */
function dropSmallGroups(mask: Uint8Array, w: number, h: number, min: number, join: number): void {
  const joined = mask.slice()
  dilate(joined, w, h, join, new Uint8Array(w * h))
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const members: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (!joined[start] || seen[start]) continue
    members.length = 0
    let count = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const i = stack.pop()!
      if (mask[i]) {
        members.push(i)
        count++
      }
      const x = i % w
      const y = (i / w) | 0
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const j = yy * w + xx
          if (joined[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    if (count < min) for (const i of members) mask[i] = 0
  }
}
