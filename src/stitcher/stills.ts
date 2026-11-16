/**
 * Still frames: the sharpest pictures there are of a piece of the map. They come from
 * three places: the camera stopping during a recording, the camera stopping during
 * live capture, and screenshots opened as images.
 *
 * The stitcher keeps them so the map can be rebuilt from them in as few, as large
 * patches as possible: see `planPatches`.
 */

export interface Keyframe {
  /**
   * Frame pixels as little-endian RGBA words (width × height of the capture), or null
   * when they were dropped to save memory and have to be read from the source again
   * (see `key`).
   */
  rgba32: Uint32Array | null
  width: number
  height: number
  /** World position of the frame's top-left pixel. */
  x: number
  y: number
  /**
   * 1 where the frame may be used, at HUD-mask scale: the crop and HUD mask as they
   * were known when the frame was taken, minus what turned out to be HUD afterwards
   * (the mouse cursor sits still with the camera and is only recognised once it moves).
   */
  valid: Uint8Array
  /** How settled each coarse cell's content was (see CompositeInput.fresh); null = all of it. */
  fresh: Float32Array | null
  /** Seconds the camera had been standing still (Infinity for screenshots). */
  settled: number
  /**
   * What to ask the frame's source for to get these pixels again (for a recording:
   * the time of the frame), or null if they can't be had again (live capture).
   */
  key: number | null
  /**
   * Places (world rectangles) where the frame may show something that only sat on the
   * screen, like the mouse cursor: the capture threw such a thing out of the map there
   * after the frame was taken, or did not take it from this frame in the first place
   * because a frame from elsewhere backed what the map had. Checked when the map is
   * rebuilt (see Mosaic.assemble).
   */
  suspects?: Array<{ x: number; y: number; w: number; h: number }>
}

/** Default memory budget for the pixels of kept still frames. A 1080p frame takes about 8.5 MB. */
export const DEFAULT_KEYFRAME_BYTES = 320 * 1024 * 1024

export class KeyframeStore {
  readonly frames: Keyframe[] = []
  maxBytes = DEFAULT_KEYFRAME_BYTES
  /** Frames lost for lack of room since the last clear() (not counting those that can be read again). */
  evicted = 0

  get bytes(): number {
    let n = 0
    for (const k of this.frames) n += bytesOf(k)
    return n
  }

  clear(): void {
    this.frames.length = 0
    this.evicted = 0
  }

  /**
   * Adds a still frame. Over budget, the most redundant frame makes room: the one
   * whose nearest neighbour is closest, since that neighbour shows nearly the same
   * area. A frame that can be read from its source again only gives up its pixels;
   * one that can't is dropped altogether.
   * @returns false if the new frame itself was dropped
   */
  add(frame: Keyframe): boolean {
    this.frames.push(frame)
    while (this.bytes > this.maxBytes) {
      let worst = -1
      let worstDist = Infinity
      for (let i = 0; i < this.frames.length; i++) {
        if (!this.frames[i].rgba32) continue
        const d = this.nearest(i)
        // `<=` so that among equals the newest goes: older frames have had their HUD
        // leftovers taken back, a fresh one hasn't yet.
        if (d <= worstDist) {
          worstDist = d
          worst = i
        }
      }
      if (worst < 0) break
      const k = this.frames[worst]
      if (k.key !== null) {
        k.rgba32 = null
        continue
      }
      // The last frame standing is kept, whatever the budget says.
      if (this.frames.length === 1) break
      this.frames.splice(worst, 1)
      this.evicted++
      if (k === frame) return false
    }
    return true
  }

  /**
   * The source the frames came from is gone: none of them can be read again. Those
   * kept without their pixels are of no use any more and are dropped.
   */
  forgetKeys(): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const k = this.frames[i]
      if (k.key === null) continue
      k.key = null
      if (k.rgba32) continue
      this.frames.splice(i, 1)
      this.evicted++
    }
  }

  private nearest(i: number): number {
    const a = this.frames[i]
    let best = Infinity
    for (let j = 0; j < this.frames.length; j++) {
      if (j === i) continue
      const b = this.frames[j]
      const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
      if (d < best) best = d
    }
    return best
  }
}

function bytesOf(k: Keyframe): number {
  return (k.rgba32 ? k.rgba32.byteLength : 0) + k.valid.byteLength + (k.fresh ? k.fresh.byteLength : 0)
}

/** Planning grid cell in pixels. */
export const PLAN_CELL = 48

/** What a still frame can contribute, on a grid of PLAN_CELL-sized cells laid over the frame. */
export interface PlanFrame {
  /** World position of the frame's top-left pixel. */
  x: number
  y: number
  cols: number
  rows: number
  /** 1 where the frame can own the map: its core, with the HUD and unsettled content left out. */
  core: Uint8Array
  /** 1 where the frame shows anything usable at all. */
  reach: Uint8Array
  /** Which of two frames taken at nearly the same place is kept: the higher (e.g. seconds at rest). */
  weight: number
}

export interface PatchPlan {
  /** Indices of the frames the map is built from, largest contribution first. */
  patches: number[]
  /** The other frames: taken at nearly the same place as a patch, or showing nothing new. */
  fillers: number[]
}

/** Frames taken closer together than this (fraction of the frame's short side) count as one stop. */
const MIN_SPACING = 0.2
/** A frame whose core adds less than this share of a frame... */
const MIN_PATCH_GAIN = 0.02
/** ...and which shows less than this share of a frame that no other chosen frame shows, is left out. */
const MIN_REACH_GAIN = 0.02

/**
 * Chooses which still frames the map is built from.
 *
 * The camera has perspective, so two stills of the same ground show raised things
 * (belts, pipes, icons) apart by an amount that grows with the distance between the
 * two camera positions. Borders between patches from positions far apart can't be
 * hidden. So every distinct stop is used: patches are smaller, but neighbours are
 * close together and fit each other. Of several frames from (nearly) the same place
 * only the best is kept, and frames that would contribute nothing are dropped.
 */
export function planPatches(frames: ReadonlyArray<PlanFrame>): PatchPlan {
  const n = frames.length
  if (n === 0) return { patches: [], fillers: [] }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of frames) {
    minX = Math.min(minX, f.x)
    minY = Math.min(minY, f.y)
    maxX = Math.max(maxX, f.x + f.cols * PLAN_CELL)
    maxY = Math.max(maxY, f.y + f.rows * PLAN_CELL)
  }
  const gw = Math.ceil((maxX - minX) / PLAN_CELL) + 1
  const gh = Math.ceil((maxY - minY) / PLAN_CELL) + 1

  // One frame per stop: best first, and nothing within MIN_SPACING of one already taken.
  const byWeight = Array.from({ length: n }, (_, i) => i).sort((a, b) => frames[b].weight - frames[a].weight || a - b)
  const distinct: number[] = []
  for (const i of byWeight) {
    const f = frames[i]
    const spacing = MIN_SPACING * Math.min(f.cols, f.rows) * PLAN_CELL
    if (distinct.every((j) => Math.hypot(frames[j].x - f.x, frames[j].y - f.y) >= spacing)) distinct.push(i)
  }

  // World cell under each cell of each frame. Frames are not aligned with the world
  // grid, but cells are the same size, so a frame's cells land on distinct world cells.
  const cellsOf = (f: PlanFrame) => {
    const out = new Int32Array(f.cols * f.rows)
    for (let cy = 0; cy < f.rows; cy++) {
      const gy = Math.floor((f.y + (cy + 0.5) * PLAN_CELL - minY) / PLAN_CELL)
      for (let cx = 0; cx < f.cols; cx++) {
        out[cy * f.cols + cx] = gy * gw + Math.floor((f.x + (cx + 0.5) * PLAN_CELL - minX) / PLAN_CELL)
      }
    }
    return out
  }
  // Order them by how much each adds (largest first), and drop those that add nothing.
  const used = new Uint8Array(n)
  const patches: number[] = []
  const cover = (pick: (f: PlanFrame) => Uint8Array, minGain: number) => {
    const covered = new Uint8Array(gw * gh)
    const mark = (i: number) => {
      const mask = pick(frames[i])
      const cells = cellsOf(frames[i])
      for (let k = 0; k < cells.length; k++) if (mask[k]) covered[cells[k]] = 1
    }
    for (const i of patches) mark(i)
    for (;;) {
      let best = -1
      let bestGain = 0
      for (const i of distinct) {
        if (used[i]) continue
        const mask = pick(frames[i])
        const cells = cellsOf(frames[i])
        let gain = 0
        for (let k = 0; k < cells.length; k++) if (mask[k] && !covered[cells[k]]) gain++
        if (gain > bestGain) {
          bestGain = gain
          best = i
        }
      }
      if (best < 0 || bestGain < minGain * frames[best].cols * frames[best].rows) break
      used[best] = 1
      patches.push(best)
      mark(best)
    }
  }
  cover((f) => f.core, MIN_PATCH_GAIN)
  cover((f) => f.reach, MIN_REACH_GAIN)
  // The remaining distinct stops add no new ground, but each is the nearest view of
  // the ground around its own centre, which is worth having.
  for (const i of distinct) {
    if (used[i]) continue
    if (!frames[i].core.some((v) => v === 1)) continue
    used[i] = 1
    patches.push(i)
  }
  const fillers: number[] = []
  for (let i = 0; i < n; i++) if (!used[i]) fillers.push(i)
  return { patches, fillers }
}
