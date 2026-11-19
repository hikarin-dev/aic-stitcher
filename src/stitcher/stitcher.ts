import {
  boxSum,
  dilate,
  distanceTransform,
  downscaleBox,
  downscaleBoxF32,
  erode,
  rgba32ToLuma,
  type Pixels,
} from './image'
import { Mosaic, RATING_CORE, type WorldBox } from './mosaic'
import { PhaseCorrelator, type Spectrum } from './phaseCorrelation'
import { refineOffset, SampleSet, selectSamples, type RefineResult } from './refine'
import { Relocalizer } from './relocalize'
import { KeyframeStore, PLAN_CELL, planPatches, type Keyframe, type PlanFrame } from './stills'
import { StillHudVotes, UiMaskEstimator } from './uiMask'

export interface CropMargins {
  /** Fractions of the frame (0..0.45) cut from each side. */
  top: number
  bottom: number
  left: number
  right: number
}

export interface StitchSettings {
  crop: CropMargins
  /** Learn and exclude static HUD elements automatically. */
  autoUiMask: boolean
  /** Even out brightness differences between frames (cloud shadows, vignette). */
  lightingCorrection: boolean
  /** Frames whose camera moves faster than this (px/s) only fill holes in the map. 0 = no limit. */
  maxSpeed: number
  /** Keep tracking, but don't write to the map. */
  paused: boolean
}

export const DEFAULT_SETTINGS: StitchSettings = {
  crop: { top: 0.06, bottom: 0.1, left: 0.02, right: 0.02 },
  autoUiMask: true,
  lightingCorrection: true,
  maxSpeed: 2500,
  paused: false,
}

export type TrackingState = 'calibrating' | 'tracking' | 'lost'

/**
 * How a frame was written to the map: 'full' while panning, 'still' when the camera
 * stood still (the sharpest frames), 'fill' when it only filled holes.
 */
export type DrawMode = 'full' | 'still' | 'fill'

export interface FrameStatus {
  state: TrackingState
  /** UI-mask calibration progress 0..1. */
  calibration: number
  frameIndex: number
  /** World position of the frame's top-left corner. */
  x: number
  y: number
  width: number
  height: number
  /** Camera speed in px/s (0 when unknown). */
  speed: number
  /** ZNCC score of the mosaic match (0..1), or null when no mosaic match was attempted. */
  matchScore: number | null
  composited: boolean
  drawMode: DrawMode | null
  /** Share of the view that showed different content than the map when last drawn (0..1). */
  disagreement: number
  /** Share of the map that is low-confidence (only seen at a frame edge, or contradicted). */
  weak: number
  /** Share of the map that was never captured from a still (sharp) frame. */
  soft: number
  /** Still frames kept so far (see Stitcher.rebuildFromStills). */
  keyframes: number
  /** Bumped every time the UI mask changes. */
  maskVersion: number
  tileCount: number
  processMs: number
  /** Per-stage timings in ms (for the debug panel). */
  timings: Record<string, number>
}

/** A still image (screenshot) to stitch. */
export interface StillImage {
  rgba: Pixels
  width: number
  height: number
}

export interface ImageStitchResult {
  total: number
  placed: number
  /** Images that could not be used (index into the input) and why. */
  skipped: Array<{ index: number; reason: string }>
  /** Whether the HUD could be learned from the images (it takes at least two). */
  hudLearned: boolean
}

/** What a rebuild is going to use (see Stitcher.rebuildBegin). */
export interface RebuildPlan {
  /** Still frames available. */
  stills: number
  /**
   * The frames the map will be rebuilt from, in order. `inMemory`: its pixels are at
   * hand; otherwise they have to be read from the source again and passed to
   * rebuildPatch(), with `key` saying which frame it is (see FrameInput.refetchKey).
   */
  patches: Array<{
    key: number | null
    inMemory: boolean
    x: number
    y: number
    /** Places where the still is checked for something that only sat on the screen (see Keyframe.suspects). */
    suspects: number
  }>
}

export interface RebuildResult {
  /** Still frames available. */
  stills: number
  /** How many of them the map was rebuilt from (the others showed nothing those didn't). */
  patches: number
  /** Pixels outside every patch, kept from the map as it was. */
  keptPixels: number
  /** Total length (px) of the borders between patches, and how much of it runs through content the two sides disagree on. */
  seamLength: number
  seamThroughConflict: number
}

export interface FrameInput {
  rgba: Pixels
  width: number
  height: number
  /** Milliseconds, monotonic. */
  timestamp: number
  /**
   * Set if the source can deliver this very frame again later (a recording can, by
   * the frame's time; a live capture can't): whatever identifies it. The stitcher then
   * doesn't have to hold on to the pixels of every still frame, and a rebuild can use
   * all of them however large they are.
   */
  refetchKey?: number
}

/** Motion-voting frames needed before we trust the HUD mask enough to draw. */
const CALIBRATION_FRAMES = 24
const MIN_MATCH_SCORE = 0.55
/**
 * A frame that follows on from the previous one is accepted down to this score: the
 * frame-to-frame motion already says where it is, and the map only has to agree
 * roughly. Without this, a stop over a part of the map that was captured blurry on
 * the way in scores just under MIN_MATCH_SCORE for as long as the camera stands there,
 * and the sharpest frames there are of that spot are thrown away.
 */
const MIN_FOLLOWING_SCORE = 0.5
/** A relocalization must beat the runner-up by this much to be trusted (repetitive factories). */
const RELOC_MARGIN = 0.04
/**
 * Camera speed (px/s at 1920 px frame width) at which a frame's quality is halved. The
 * game blurs moving frames and the video encoder smears them further.
 */
const SPEED_HALF_QUALITY = 1500
/** No moving frame is rated higher than this: only a still frame is truly sharp. */
const MOVING_MAX_QUALITY = 0.75
/**
 * Quality of the first frames after the camera stops; from STILL_SETTLE seconds on it
 * is 1. The video encoder needs a moment to rebuild the detail it dropped while
 * moving, so a stop yields a provisional sample right away and one settled sample
 * that replaces it. Two steps, not a ramp: a ramp would rewrite the map every frame.
 */
const STILL_BASE_QUALITY = 0.8
const STILL_SETTLE = 0.4
/**
 * A stop of the camera is one picture (see CompositeInput.own). Its frames replace
 * each other until the picture has settled, this many seconds after stopping: by then
 * the encoder has caught up and whatever had just scrolled in counts fully (see
 * FRESH_SETTLED). From then on the stop is left alone, however long it lasts: a menu
 * opened later or the cursor wandering about are none of the map's business, and
 * belts and machines would only be redrawn in yet another state.
 */
const STOP_SETTLED = 0.6
/**
 * A frame only replaces the earlier ones of its stop if it is as sharp as the sharpest
 * of them (to within this share, for noise). In a recording every frame of a stop is
 * sharper than the one before, by a percent or two each, as the encoder catches up:
 * there the last frame wins. A screen share has no encoder, its frames are equally
 * sharp, and the latest wins too. A frame that is softer for whatever reason never does.
 */
const STOP_MIN_SHARPNESS = 0.99
/**
 * Drawing a frame is the expensive part of processing it, so a stop is not redrawn
 * with every frame. After the first, a frame is drawn if it is this much sharper than
 * the picture the stop has, if this share of the screen has settled since (what had
 * just scrolled in when the camera stopped, see FRESH_SETTLED), or when one of the two
 * moments has come at which a frame counts for more than the ones before it
 * (STILL_SETTLE, STOP_SETTLED).
 */
const STOP_SHARPER = 1.02
const STOP_MORE_SETTLED = 0.03
/**
 * Minimum camera movement between frames that are drawn in full while panning, as a
 * fraction of the frame's short side. What scrolls into view in between is filled in
 * from every frame, which costs next to nothing (see MIN_MISSING); a full draw compares
 * the whole frame with the map and is the expensive part of processing a frame. At
 * this step every spot is still seen two or three times mid-screen on the way across.
 */
const PAN_STEP = 0.15
/**
 * The same for the first full draws after a stop. What sat on the screen during the
 * stop (the cursor) is thrown out when two frames from elsewhere agree against it, and
 * the sooner the better: those frames have to see the spot before it leaves the screen.
 */
const COMPOSITE_STEP = 0.05
const FINE_STEPS_AFTER_STOP = 2
/** The map's confidence figures (a scan of every tile that changed) are refreshed after this many draws. */
const STATS_EVERY = 24
/** A frame only confirms what the map shows if the camera moved this far (fraction of the short side). */
const CONFIRM_STEP = 0.03
const CONFIRM_MAX_SPEED = 1500
/**
 * Frame quality comes in flat zones, not a ramp. The **core** is everything further
 * than CORE_DISTANCE (fraction of the crop's short side) from the frame/HUD edges: the
 * game hides facility icons in a wide margin along the screen edges (where its HUD
 * lives), so only the middle of the screen shows the factory the way the map should.
 * The **margin** around it counts MARGIN_QUALITY, fading to nothing over the last
 * EDGE_FEATHER at the very edge.
 *
 * Flat on purpose: with a ramp, "is this frame better than what the map has?" would
 * flip somewhere in the middle of a machine, and the machine would end up stitched
 * together from two frames. With zones the answer is the same across the machine.
 */
const CORE_DISTANCE = 0.22
const MARGIN_QUALITY = 0.5
const EDGE_FEATHER = 0.03
/** Width of the step between zones (fraction of the short side): just enough to feather the seam. */
const ZONE_STEP = 0.028
/**
 * The core of a still frame, for joining stills (rebuildFromStills, stitchImages):
 * everything further than this (fraction of the crop's short side) from the frame
 * edges and the HUD.
 *
 * Measured on Endfield recordings by checking, for icons and labels seen mid-screen in
 * one still, whether another still shows them too: within about 11 % of the frame
 * height of the HUD or the crop edge most are missing (the game hides them where its
 * HUD lives), beyond that practically none. CORE_DISTANCE above was set by eye before
 * that measurement and is more cautious than it needs to be; it is left alone because
 * the capture pass is tuned around it.
 */
const STILL_CORE_DISTANCE = 0.14
/**
 * A still rates each of its pixels for Mosaic.assemble. In its margin: from 0 at the
 * edge up to just under RATING_CORE at the rim of the core. In its core: from 255 at
 * the centre of the screen down to RATING_CORE at the corners, by distance from the
 * centre.
 *
 * By distance from the centre because the camera has perspective: the further from
 * the centre of the screen, the more raised things lean outwards. Where two stills
 * overlap, each spot then goes to the one that looked at it most squarely, and the
 * border falls halfway between the two camera positions, where both views lean by
 * the same amount in opposite directions.
 */
/** Quality factor of pixels that are only shown because nothing better exists (HUD in the way). */
const LAST_RESORT_QUALITY = 0.05
/** Share of a still image that has to lie on what is already placed for it to be located. */
const STILL_MIN_OVERLAP = 0.25
/**
 * A still image is first placed where it fits with at least STILL_MIN_SCORE, provided
 * no other place comes within STILL_MARGIN of that. The score is allowed to be lower
 * than for video (MIN_MATCH_SCORE): the images placed before still have their HUD in
 * them at this point, and wherever that covers the map the comparison fails. Every
 * such placement is checked again once the HUD is known (see stitchImages).
 */
const STILL_MIN_SCORE = 0.3
const STILL_MARGIN = 0.1
/** At most this many still images are compared with each other to learn the HUD... */
const STILL_MASK_IMAGES = 24
/** ...each with this many of its nearest neighbours. */
const STILL_MASK_NEIGHBOURS = 4
/** Lighting weight ramps up over this fraction: a long feather, so lighting blends smoothly. */
const LIGHT_RAMP = 0.25
/** The HUD mask is rebuilt after this many frames of new evidence. */
const MASK_REFRESH = 4
/** Largest growth of the HUD mask (fraction of the frame) that is taken back from the map. */
const RETRACT_MAX_AREA = 0.01
/** Most places a still frame is told to be checked at when the map is rebuilt (see Keyframe.suspects). */
const MAX_SUSPECTS = 64
/** Hole samples (see Mosaic.countMissing) that make a frame worth drawing just to fill them. */
const MIN_MISSING = 3
/**
 * The game pops facility icons in a moment after a facility scrolls into view, so what
 * has just entered the screen may still be missing them. Content counts fully once it
 * has been on screen for FRESH_SETTLED seconds; before FRESH_START it barely counts
 * (it still fills holes, and is replaced as soon as a settled view of it comes along).
 * A short step between the two, for the same reason the quality zones are flat.
 */
const FRESH_START = 0.45
const FRESH_SETTLED = 0.55
const FRESH_MIN_QUALITY = 0.12

/** All per-resolution buffers. Recreated when the capture size changes. */
class Geometry {
  readonly w: number
  readonly h: number
  readonly lum: Uint8Array
  readonly q: Uint8Array
  /** Rating of each pixel when the frame is joined to others as a still (see buildValidity). */
  readonly rate: Uint8Array
  readonly dist: Uint16Array
  readonly validTmp: Uint8Array

  // Coarse (phase correlation) scale, s = ls * ms
  readonly s: number
  readonly ls: number
  readonly lw: number
  readonly lh: number
  readonly low: Float32Array
  readonly lowValid: Uint8Array
  readonly correlator: PhaseCorrelator
  specCur: Spectrum
  specRef: Spectrum
  /** Local brightness of the current frame at coarse scale (see CompositeInput.shade). */
  readonly shade: Float32Array
  readonly shadeWeight: Float32Array
  /** Seconds each coarse cell's content has been on screen, and the quality factor derived from it. */
  age: Float32Array
  private ageTmp: Float32Array
  readonly fresh: Float32Array
  private readonly bufV: Float32Array
  private readonly bufM: Float32Array
  private readonly sumV: Float32Array
  private readonly sumM: Float32Array
  private readonly tmp: Float32Array

  // HUD mask scale
  readonly ms: number
  readonly mw: number
  readonly mh: number
  maskLumCur: Float32Array
  maskLumPrev: Float32Array
  readonly uiMask: Uint8Array
  readonly estimator: UiMaskEstimator
  /** 1 / vignette at mask scale, and the vignette parameters it was computed for. */
  private readonly flat: Float32Array
  private flatFor = new Float64Array(0)
  /** Vignette at coarse scale, and the parameters it was computed for. */
  private readonly vig: Float32Array
  private vigFor = new Float64Array(0)

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    const n = w * h
    this.lum = new Uint8Array(n)
    this.q = new Uint8Array(n)
    this.rate = new Uint8Array(n)
    this.dist = new Uint16Array(n)
    this.validTmp = new Uint8Array(n)

    // Coarse scale is a multiple of the mask scale so it can be derived from the mask image.
    // ~960 px wide: fine enough that thin HUD text isn't averaged away with the map.
    this.ms = Math.max(1, Math.round(w / 960))
    this.mw = Math.floor(w / this.ms)
    this.mh = Math.floor(h / this.ms)
    // ceil: keep the coarse image <= 256 px wide (FFT 256x128), whatever the capture size.
    this.ls = Math.max(1, Math.ceil(w / 256 / this.ms))
    this.s = this.ls * this.ms
    this.lw = Math.floor(w / this.s)
    this.lh = Math.floor(h / this.s)
    const ln = this.lw * this.lh
    this.low = new Float32Array(ln)
    this.lowValid = new Uint8Array(ln)
    this.correlator = new PhaseCorrelator(this.lw, this.lh)
    this.specCur = this.correlator.createSpectrum()
    this.specRef = this.correlator.createSpectrum()
    this.shade = new Float32Array(ln).fill(1)
    this.shadeWeight = new Float32Array(ln)
    this.age = new Float32Array(ln)
    this.ageTmp = new Float32Array(ln)
    this.fresh = new Float32Array(ln).fill(FRESH_MIN_QUALITY)
    this.bufV = new Float32Array(ln)
    this.bufM = new Float32Array(ln)
    this.sumV = new Float32Array(ln)
    this.sumM = new Float32Array(ln)
    this.tmp = new Float32Array(ln)

    this.maskLumCur = new Float32Array(this.mw * this.mh)
    this.maskLumPrev = new Float32Array(this.mw * this.mh)
    this.uiMask = new Uint8Array(this.mw * this.mh)
    this.estimator = new UiMaskEstimator(this.mw, this.mh)
    this.flat = new Float32Array(this.mw * this.mh).fill(1)
    this.vig = new Float32Array(ln).fill(1)
  }

  /**
   * Takes the vignette out of the mask-scale image (in place). The HUD detector
   * compares a pixel with where it was a moment ago; under a vignette the same piece
   * of world has a different brightness there, which reads as "did not move with the
   * world", i.e. as HUD.
   */
  flattenMaskLum(theta: Float64Array): void {
    const { mw, mh, flat } = this
    let stale = this.flatFor.length !== theta.length
    for (let k = 0; !stale && k < theta.length; k++) stale = Math.abs(theta[k] - this.flatFor[k]) > 0.01
    if (stale) {
      this.flatFor = Float64Array.from(theta)
      for (let y = 0; y < mh; y++) {
        const v = ((y + 0.5) / mh) * 2 - 1
        const v2 = v * v
        for (let x = 0; x < mw; x++) {
          const u = ((x + 0.5) / mw) * 2 - 1
          const u2 = u * u
          const l =
            theta[0] * u2 + theta[1] * v2 + theta[2] * u2 * u2 + theta[3] * v2 * v2 + theta[4] * u2 * v2 + theta[5] * u + theta[6] * v
          flat[y * mw + x] = Math.min(3, Math.exp(-l))
        }
      }
    }
    const lum = this.maskLumCur
    for (let i = 0; i < mw * mh; i++) lum[i] *= flat[i]
  }

  /**
   * Tracks how long the content of every screen cell has been visible.
   * @param dx,dy camera movement since the previous frame in pixels, or null when
   *   unknown (first frame, after a jump): everything counts as just revealed
   * @param dt seconds since the previous frame
   */
  updateAge(dx: number | null, dy: number, dt: number): void {
    const { lw, lh, s, fresh } = this
    const n = lw * lh
    if (dx === null) {
      this.age.fill(0)
    } else {
      // The camera moved by (dx, dy), so what is at cell (cx, cy) now was at
      // (cx + dx/s, cy + dy/s) before, or off screen.
      const sx = Math.round(dx / s)
      const sy = Math.round(dy / s)
      const prev = this.age
      const next = this.ageTmp
      for (let cy = 0; cy < lh; cy++) {
        const py = cy + sy
        const rowOk = py >= 0 && py < lh
        for (let cx = 0; cx < lw; cx++) {
          const px = cx + sx
          next[cy * lw + cx] = rowOk && px >= 0 && px < lw ? prev[py * lw + px] + dt : 0
        }
      }
      this.age = next
      this.ageTmp = prev
    }
    const age = this.age
    const span = FRESH_SETTLED - FRESH_START
    for (let i = 0; i < n; i++) {
      const t = Math.max(0, Math.min(1, (age[i] - FRESH_START) / span))
      fresh[i] = FRESH_MIN_QUALITY + (1 - FRESH_MIN_QUALITY) * t * t * (3 - 2 * t)
    }
  }

  /**
   * Local brightness of the frame: the coarse luma blurred over a few cells, using
   * only valid (non-HUD, non-cropped) cells, and extrapolated into the invalid ones.
   *
   * The blur runs on the vignette-free image and the vignette is put back afterwards.
   * At the edge of the valid area the blur can only look inwards, where the vignette
   * is weaker; blurring the vignette along with the picture would overestimate the
   * brightness there, and whatever enters the map from a frame's edge would come out
   * a few percent too dark (bands across the direction of travel).
   */
  computeShade(theta: Float64Array): void {
    const { lw, lh, low, lowValid, shade, bufV, bufM, sumV, sumM, tmp, vig } = this
    const n = lw * lh
    let stale = this.vigFor.length !== theta.length
    for (let k = 0; !stale && k < theta.length; k++) stale = Math.abs(theta[k] - this.vigFor[k]) > 0.002
    if (stale) {
      this.vigFor = Float64Array.from(theta)
      for (let y = 0; y < lh; y++) {
        const v = ((y + 0.5) / lh) * 2 - 1
        const v2 = v * v
        for (let x = 0; x < lw; x++) {
          const u = ((x + 0.5) / lw) * 2 - 1
          const u2 = u * u
          const l =
            theta[0] * u2 + theta[1] * v2 + theta[2] * u2 * u2 + theta[3] * v2 * v2 + theta[4] * u2 * v2 + theta[5] * u + theta[6] * v
          vig[y * lw + x] = Math.max(0.2, Math.exp(l))
        }
      }
    }
    let total = 0
    let count = 0
    for (let i = 0; i < n; i++) {
      const m = lowValid[i]
      bufM[i] = m
      bufV[i] = m ? low[i] / vig[i] : 0
      total += bufV[i]
      count += m
    }
    // Two box passes ≈ a triangle filter about 6 % of the frame width wide. Wide enough
    // to leave machines and belts in the detail layer, narrow enough to follow the soft
    // edge of a cloud shadow.
    const r = Math.max(2, Math.round(lw / 80))
    boxSum(bufV, lw, lh, r, sumV, tmp)
    boxSum(bufM, lw, lh, r, sumM, tmp)
    boxSum(sumV, lw, lh, r, bufV, tmp)
    boxSum(sumM, lw, lh, r, bufM, tmp)
    const mean = count > 0 ? total / count : 1
    for (let i = 0; i < n; i++) {
      const v = (bufM[i] > 0 ? bufV[i] / bufM[i] : mean) * vig[i]
      shade[i] = v > 1 ? v : 1
    }
  }
}

export class Stitcher {
  readonly mosaic = new Mosaic()
  settings: StitchSettings
  private g: Geometry | null = null
  private validityDirty = true
  private maskVersion = 0
  private observationsSinceMask = 0
  private frameIndex = 0

  // Tracking state
  private hasRef = false
  private refX = 0
  private refY = 0
  private prevValid = false
  private prevX = 0
  private prevY = 0
  private prevTime = 0
  private lastX = 0
  private lastY = 0
  private lostFrames = 0
  /** Position of the last composited frame (null = none since the last jump/reset). */
  private lastDrawn: { x: number; y: number } | null = null
  /** Position of the last frame whose agreement counted as confirmation. */
  private lastConfirm: { x: number; y: number } | null = null
  /** Consecutive frames at exactly the previous frame's position, and for how long (s). */
  private stillFrames = 0
  private stillTime = 0
  /** Frames drawn during the current stop. */
  private stillDraws = 0
  /** Where the camera last stood still and drew (null = nowhere yet / map cleared). */
  private lastStop: { x: number; y: number } | null = null
  private maskBefore = new Uint8Array(0)
  private disagreement = 0
  private weak = 0
  private soft = 0
  private statsAge = 0

  private keyframes = new KeyframeStore()
  /** Still frame of the current (or most recent) stop. */
  private stopKeyframe: Keyframe | null = null
  /** HUD mask learned from still images (1 = HUD), separate from the one learned from motion. */
  private stillMask: Uint8Array | null = null
  /** Whether anything from a capture (not a screenshot) has been drawn on the map. */
  private videoDrawn = false
  /** Whether a capture has drawn on the map since it was last rebuilt from its still frames. */
  private unassembled = false
  private qualityByDistance = new Uint8Array(4096)
  /** Scratch for buildValidity: the mask cell each pixel column is in, and one mask row's quality. */
  private cellOfColumn = new Int32Array(0)
  private cellQuality = new Uint8Array(0)
  private ratingByDistance = new Uint8Array(4096)
  private samples = new SampleSet()
  private region = new Uint8Array(0)
  private regionQ = new Uint8Array(0)
  private relocalizer = new Relocalizer()

  constructor(settings: StitchSettings = DEFAULT_SETTINGS) {
    this.settings = structuredClone(settings)
    this.mosaic.blendLighting = settings.lightingCorrection
  }

  updateSettings(settings: StitchSettings): void {
    const prev = this.settings
    this.settings = structuredClone(settings)
    const c0 = prev.crop
    const c1 = settings.crop
    if (
      c0.top !== c1.top ||
      c0.bottom !== c1.bottom ||
      c0.left !== c1.left ||
      c0.right !== c1.right ||
      prev.autoUiMask !== settings.autoUiMask
    ) {
      this.validityDirty = true
    }
    this.mosaic.blendLighting = settings.lightingCorrection
  }

  /** Clears the map but keeps the learned HUD mask. */
  clearMap(): void {
    this.mosaic.clear()
    this.hasRef = false
    this.prevValid = false
    this.lostFrames = 0
    this.lastX = 0
    this.lastY = 0
    this.lastDrawn = null
    this.lastConfirm = null
    this.lastStop = null
    this.stillFrames = 0
    this.stillDraws = 0
    this.disagreement = 0
    this.weak = 0
    this.soft = 0
    this.keyframes.clear()
    this.stopKeyframe = null
    this.videoDrawn = false
    this.unassembled = false
    this.rebuilding = null
  }

  /** Forgets the learned HUD mask (e.g. after changing the in-game UI layout). */
  resetUiMask(): void {
    if (!this.g) return
    this.g.estimator.reset()
    this.g.uiMask.fill(0)
    this.stillMask = null
    this.validityDirty = true
    this.maskVersion++
  }

  get isCalibrated(): boolean {
    return !this.settings.autoUiMask || (this.g?.estimator.observations ?? 0) >= CALIBRATION_FRAMES
  }

  /** HUD mask at mask scale (1 = HUD) plus its scale, for display. */
  getUiMask(): { mask: Uint8Array; width: number; height: number; scale: number } | null {
    const g = this.g
    return g ? { mask: g.uiMask, width: g.mw, height: g.mh, scale: g.ms } : null
  }

  /** Local brightness of the current frame on the coarse grid, for debugging. */
  getShade(): { shade: Float32Array; valid: Uint8Array; width: number; height: number; scale: number } | null {
    const g = this.g
    return g ? { shade: g.shade, valid: g.lowValid, width: g.lw, height: g.lh, scale: g.s } : null
  }

  /** Per-pixel quality of the current frame (0 = excluded), for display/debugging. */
  getQualityMap(): { q: Uint8Array; width: number; height: number } | null {
    const g = this.g
    return g ? { q: g.q, width: g.w, height: g.h } : null
  }

  process(input: FrameInput): FrameStatus {
    const t0 = performance.now()
    const timings: Record<string, number> = {}
    let tMark = t0
    const mark = (name: string) => {
      const now = performance.now()
      timings[name] = (timings[name] ?? 0) + now - tMark
      tMark = now
    }
    const { width: W, height: H, rgba } = input
    const rgba32 = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H)
    let g = this.g
    if (!g || g.w !== W || g.h !== H) {
      g = this.g = new Geometry(W, H)
      this.validityDirty = true
      this.hasRef = false
      this.prevValid = false
      this.maskVersion++
      this.keyframes.clear()
      this.stopKeyframe = null
      this.stillMask = null
      if (!this.mosaic.isEmpty) {
        this.lostFrames = Math.max(this.lostFrames, 1)
        // The stills the map was made from are gone: it can only be added to from here on.
        this.videoDrawn = true
      }
    }
    this.frameIndex++
    const { settings, mosaic } = this

    rgba32ToLuma(rgba32, g.lum, W * H)
    downscaleBox(g.lum, W, g.ms, g.maskLumCur, g.mw, g.mh)
    downscaleBoxF32(g.maskLumCur, g.mw, g.ls, g.low, g.lw, g.lh)
    // (after `low` is derived: lighting needs the frame as captured, vignette included)
    g.flattenMaskLum(mosaic.vignette)
    mark('preprocess')
    if (this.validityDirty) this.recomputeValidity(g)
    g.computeShade(mosaic.vignette)
    mark('validity')

    // 1) Coarse motion vs. the last good frame (phase correlation, low resolution).
    g.correlator.computeSpectrum(g.low, g.lowValid, g.specCur)
    let coarse: { x: number; y: number } | null = null
    if (this.hasRef) {
      const est = g.correlator.correlate(g.specCur, g.specRef)
      if (est.peak > 0.03 && est.ratio > 1.3) {
        coarse = { x: this.refX - Math.round(est.dx * g.s), y: this.refY - Math.round(est.dy * g.s) }
      }
    }
    mark('coarse')

    // 2) Refine against the mosaic at full resolution (removes accumulated drift).
    const baseRadius = g.s + 3
    let predX = coarse ? coarse.x : this.hasRef ? this.refX : this.lastX
    let predY = coarse ? coarse.y : this.hasRef ? this.refY : this.lastY
    let radius = coarse ? baseRadius : baseRadius * 3

    let refined: RefineResult | null = null
    let relocalized = false
    let minScore = MIN_MATCH_SCORE
    if (!mosaic.isEmpty) {
      selectSamples(g.lum, g.q, W, H, 5, 10, this.samples, { shade: g.shade, w: g.lw, h: g.lh, scale: g.s })
      refined = this.refineAt(g, predX, predY, radius, radius > baseRadius ? 1500 : 2500)
      // Best match on the edge of the search window: the true offset is probably
      // further out (bad coarse estimate). Search once more around it, wider.
      if (refined && (Math.abs(refined.dx) === radius || Math.abs(refined.dy) === radius)) {
        predX += refined.dx
        predY += refined.dy
        radius = Math.min(64, radius * 2)
        refined = this.refineAt(g, predX, predY, radius, 1500)
      }
      mark('refine')

      // 3) Local tracking failed (fast drag, jump, menu closed elsewhere): search the
      //    whole map instead of insisting on where we were.
      // (Within one coarse step of where the motion from the previous frame puts it.)
      if (
        refined &&
        coarse &&
        this.prevValid &&
        Math.abs(predX + refined.dx - coarse.x) <= g.s &&
        Math.abs(predY + refined.dy - coarse.y) <= g.s
      ) {
        minScore = MIN_FOLLOWING_SCORE
      }
      const localOk = (refined && refined.score >= minScore) || (coarse && !refined)
      if (!localOk) {
        // A position found by searching the whole map has to earn the full score.
        minScore = MIN_MATCH_SCORE
        const hit = this.relocalize(g)
        mark('relocalize')
        if (hit) {
          predX = hit.x
          predY = hit.y
          radius = baseRadius
          refined = this.refineAt(g, predX, predY, radius, 2500)
          relocalized = !!refined && refined.score >= MIN_MATCH_SCORE
          mark('refine')
        }
      }
    }

    // 4) Decide where this frame is.
    let good = false
    let x = predX
    let y = predY
    if (refined && refined.score >= minScore) {
      x = predX + refined.dx
      y = predY + refined.dy
      good = true
    } else if (coarse && !refined) {
      // Not enough overlap with the map (or map empty): trust the frame-to-frame motion.
      good = true
    } else if (!this.hasRef && mosaic.isEmpty) {
      // Very first frame.
      x = this.lastX
      y = this.lastY
      good = true
    }
    if (relocalized) {
      // Motion relative to the previous frame is meaningless after a jump.
      this.prevValid = false
      this.lastDrawn = null
      this.lastConfirm = null
    }

    let drawMode: DrawMode | null = null
    let speed = 0
    if (good) {
      const dt = (input.timestamp - this.prevTime) / 1000
      if (this.prevValid && dt > 0) speed = Math.hypot(x - this.prevX, y - this.prevY) / dt
      if (this.prevValid) g.updateAge(x - this.prevX, y - this.prevY, Math.max(0, Math.min(0.5, dt)))
      else g.updateAge(null, 0, 0)
      if (this.prevValid && x === this.prevX && y === this.prevY) {
        this.stillFrames++
        this.stillTime += Math.max(0, Math.min(0.5, dt))
      } else {
        this.stillFrames = 0
        this.stillTime = 0
        this.stillDraws = 0
        this.stopOwnCurrent = false
        this.stopDone = false
      }

      // HUD learning from consecutive good frames.
      if (settings.autoUiMask && this.prevValid) {
        const cdx = Math.round((this.prevX - x) / g.ms)
        const cdy = Math.round((this.prevY - y) / g.ms)
        if (Math.max(Math.abs(cdx), Math.abs(cdy)) >= 2) {
          g.estimator.observe(g.maskLumCur, g.maskLumPrev, cdx, cdy)
          this.observationsSinceMask++
          const calibrating = g.estimator.observations <= CALIBRATION_FRAMES
          if (calibrating || this.observationsSinceMask >= MASK_REFRESH) {
            if (this.maskBefore.length !== g.uiMask.length) this.maskBefore = new Uint8Array(g.uiMask.length)
            const before = this.maskBefore
            before.set(g.uiMask)
            g.estimator.computeMask(g.uiMask)
            this.observationsSinceMask = 0
            // Once learned, the mask mostly comes out the same: nothing to redo then.
            let changed = false
            for (let i = 0; i < before.length && !changed; i++) changed = before[i] !== g.uiMask[i]
            if (changed) {
              this.validityDirty = true
              this.maskVersion++
              this.retractNewHud(g)
            }
          }
        }
      }
      mark('uiMask')

      // Draw.
      if (this.isCalibrated && !settings.paused) {
        if (this.validityDirty) {
          this.recomputeValidity(g)
          g.computeShade(mosaic.vignette)
          mark('validity')
        }
        const short = Math.min(W, H)
        // Speeds are tuned at 1920 px wide frames; the same pan covers fewer pixels on a smaller capture.
        const speedRef = speed * (1920 / W)
        const drawnDist = this.lastDrawn
          ? Math.max(Math.abs(x - this.lastDrawn.x), Math.abs(y - this.lastDrawn.y))
          : Infinity
        let speedFactor = Math.min(MOVING_MAX_QUALITY, 1 / (1 + speedRef / SPEED_HALF_QUALITY))
        if (this.stillFrames > 0) {
          // The camera stands still: these are the sharpest frames there are. Draw
          // right away, then again while the picture is still settling, whenever that
          // improves it (see STOP_SHARPER).
          if (!this.stopDone) {
            const sharp = sharpness(g.lum, g.q, W, H)
            const first = this.stillDraws === 0
            let settledCells = 0
            for (let i = 0; i < g.fresh.length; i++) if (g.fresh[i] >= 0.98) settledCells++
            const due =
              (this.stillTime >= STILL_SETTLE && this.stopDrawnAt < STILL_SETTLE) ||
              this.stillTime >= STOP_SETTLED ||
              settledCells - this.stopSettledCells >= STOP_MORE_SETTLED * g.fresh.length
            if (
              first ||
              sharp >= STOP_SHARPER * this.stopSharpness ||
              (due && sharp >= STOP_MIN_SHARPNESS * this.stopSharpness)
            ) {
              drawMode = 'still'
              speedFactor = this.stillTime >= STILL_SETTLE ? 1 : STILL_BASE_QUALITY
              if (first || sharp > this.stopSharpness) this.stopSharpness = sharp
              this.stopDrawnAt = this.stillTime
              this.stopSettledCells = settledCells
            }
          }
        } else if (
          (settings.maxSpeed <= 0 || speed <= settings.maxSpeed) &&
          drawnDist >= (this.fullsSinceStop < FINE_STEPS_AFTER_STOP ? COMPOSITE_STEP : PAN_STEP) * short
        ) {
          // Compositing is the most expensive step: while panning, only do it once the
          // view has moved far enough (see PAN_STEP).
          drawMode = 'full'
          this.fullsSinceStop++
        }
        // Whatever the map doesn't have yet is worth taking from any frame we can place.
        if (!drawMode && mosaic.countMissing(x, y, W, H, g.q) >= MIN_MISSING) drawMode = 'fill'

        if (drawMode) {
          const confirmDist = this.lastConfirm
            ? Math.max(Math.abs(x - this.lastConfirm.x), Math.abs(y - this.lastConfirm.y))
            : Infinity
          // Seeing the same thing again only proves something if the camera moved in
          // between: HUD leftovers and the cursor travel with the screen, the world doesn't.
          const confirm = drawMode !== 'fill' && confirmDist >= CONFIRM_STEP * short && speedRef <= CONFIRM_MAX_SPEED
          // While the camera rests, every frame is the same view at another moment.
          let own: Uint8Array | undefined
          if (this.stillFrames > 0) {
            if (this.stopOwn.length !== W * H) {
              this.stopOwn = new Uint8Array(W * H)
              this.stopOwnCurrent = true
            } else if (!this.stopOwnCurrent) {
              this.stopOwn.fill(0)
              this.stopOwnCurrent = true
            }
            own = this.stopOwn
          }
          const result = mosaic.composite({
            rgba32,
            lum: g.lum,
            q: g.q,
            width: W,
            height: H,
            x,
            y,
            shade: g.shade,
            shadeWeight: g.shadeWeight,
            shadeW: g.lw,
            shadeH: g.lh,
            shadeScale: g.s,
            fresh: g.fresh,
            // Repeated looks from one spot refine the lighting, but must not out-shout
            // every other frame: that would stamp the frame's outline into the lighting.
            lightScale: drawMode === 'still' ? 1 / (1 + this.stillDraws) : 1,
            speedFactor,
            confirm,
            mode: drawMode === 'fill' ? 'fill' : 'full',
            own,
          })
          this.videoDrawn = true
          this.unassembled = true
          if (result.transients) this.noteTransients(result.transients)
          if (drawMode !== 'fill') {
            this.lastDrawn = { x, y }
            if (confirm) this.lastConfirm = { x, y }
            if (result.overlap > 0) this.disagreement = result.conflicts / result.overlap
            if (drawMode === 'still') {
              this.captureKeyframe(g, rgba32, x, y, this.stillDraws === 0, input.refetchKey ?? null)
              // What this frame alone shows of a spot, a rebuild from it should not put on the map.
              if (result.contradicted && this.stopKeyframe) this.suspect(this.stopKeyframe, result.contradicted)
              this.stillDraws++
              this.fullsSinceStop = 0
              if (this.stillTime >= STOP_SETTLED) this.stopDone = true
              this.lastStop = { x, y }
            }
          }
          this.statsAge++
          mark('composite')
        }
      }

      // Current frame becomes the reference for the next one.
      const tmpSpec = g.specRef
      g.specRef = g.specCur
      g.specCur = tmpSpec
      const tmpMask = g.maskLumPrev
      g.maskLumPrev = g.maskLumCur
      g.maskLumCur = tmpMask
      this.hasRef = true
      this.refX = x
      this.refY = y
      this.prevValid = true
      this.prevX = x
      this.prevY = y
      this.prevTime = input.timestamp
      this.lastX = x
      this.lastY = y
      this.lostFrames = 0
    } else {
      this.lostFrames++
      this.prevValid = false
      this.stillFrames = 0
      this.stopOwnCurrent = false
      this.stopDone = false
    }

    // Map confidence is cached per tile; refresh the totals every few composites.
    if (this.statsAge >= STATS_EVERY) {
      this.statsAge = 0
      const s = mosaic.stats()
      this.weak = s.covered > 0 ? s.weak / s.covered : 0
      this.soft = s.covered > 0 ? s.soft / s.covered : 0
      mark('stats')
    }

    const calibrated = this.isCalibrated
    let state: TrackingState
    if (!good) state = 'lost'
    else if (!calibrated) state = 'calibrating'
    else state = 'tracking'

    return {
      state,
      calibration: settings.autoUiMask ? Math.min(1, g.estimator.observations / CALIBRATION_FRAMES) : 1,
      frameIndex: this.frameIndex,
      x: good ? x : this.lastX,
      y: good ? y : this.lastY,
      width: W,
      height: H,
      speed,
      matchScore: refined ? refined.score : null,
      composited: drawMode !== null,
      drawMode,
      disagreement: this.disagreement,
      weak: this.weak,
      soft: this.soft,
      keyframes: this.keyframes.frames.length,
      maskVersion: this.maskVersion,
      tileCount: mosaic.tiles.size,
      processMs: performance.now() - t0,
      timings,
    }
  }

  /**
   * The HUD mask only learns while the camera moves, so whatever sat on the screen
   * during the last stop (the mouse cursor, a tooltip) went into the map with the
   * still frames. Once the mask picks it up, take those pixels back: they are marked
   * worthless and the frames now panning past replace them.
   */
  private retractNewHud(g: Geometry): void {
    const stop = this.lastStop
    if (!stop || !this.isCalibrated) return
    const { mw, mh, ms, uiMask } = g
    const before = this.maskBefore
    // Only inside the crop (nothing outside it was ever drawn), and only if the mask
    // grew by something cursor- or tooltip-sized: a mask that changes all over is the
    // detector still learning, not a new object.
    const c = this.settings.crop
    const mx0 = Math.ceil((c.left * g.w) / ms)
    const mx1 = Math.floor(((1 - c.right) * g.w) / ms)
    const my0 = Math.ceil((c.top * g.h) / ms)
    const my1 = Math.floor(((1 - c.bottom) * g.h) / ms)
    let grown = 0
    for (let my = my0; my < my1; my++) {
      for (let mx = mx0; mx < mx1; mx++) if (uiMask[my * mw + mx] && !before[my * mw + mx]) grown++
    }
    if (grown === 0 || grown > RETRACT_MAX_AREA * mw * mh) return
    for (let my = my0; my < my1; my++) {
      for (let mx = mx0; mx < mx1; mx++) {
        const i = my * mw + mx
        if (!uiMask[i] || before[i]) continue
        // Run of newly masked pixels on this row.
        let end = mx + 1
        while (end < mx1 && uiMask[my * mw + end] && !before[my * mw + end]) end++
        this.mosaic.demote(stop.x + mx * ms, stop.y + my * ms, (end - mx) * ms, ms)
        this.stopKeyframe?.valid.fill(0, my * mw + mx, my * mw + end)
        mx = end - 1
      }
    }
  }

  /**
   * Something that sat on the screen during a stop (the cursor, a tooltip) has been
   * found in the map and is being thrown out. The still frames taken there show it
   * too, and a rebuild from them would put it back: they are told where to look.
   */
  private noteTransients(boxes: ReadonlyArray<WorldBox>): void {
    for (const k of this.keyframes.frames) this.suspect(k, boxes)
  }

  /** Tells a still frame where it may show something that was only on the screen (see Keyframe.suspects). */
  private suspect(k: Keyframe, boxes: ReadonlyArray<WorldBox>): void {
    for (const b of boxes) {
      if (b.x >= k.x + k.width || b.x + b.w <= k.x || b.y >= k.y + k.height || b.y + b.h <= k.y) continue
      const list = (k.suspects ??= [])
      // (The same place comes up again with every frame that sees it.)
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      if (list.some((o) => cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h)) continue
      if (list.length < MAX_SUSPECTS) list.push(b)
    }
  }

  /** Number of still frames kept for rebuildFromStills(). */
  get keyframeCount(): number {
    return this.keyframes.frames.length
  }

  /**
   * The source of the frames is gone (the recording was closed): what was pushed with
   * a `refetchKey` can no longer be read again. Keys of one recording must not be
   * asked of the next.
   */
  forgetSource(): void {
    this.keyframes.forgetKeys()
    if (this.stopKeyframe && !this.keyframes.frames.includes(this.stopKeyframe)) this.stopKeyframe = null
  }

  /** Memory budget for kept still frames, in bytes. */
  setKeyframeBudget(bytes: number): void {
    this.keyframes.maxBytes = bytes
  }

  /** The current frame was drawn while the camera stood still: keep it. */
  private captureKeyframe(
    g: Geometry,
    rgba32: Uint32Array,
    x: number,
    y: number,
    newStop: boolean,
    key: number | null,
  ): void {
    let kf = newStop ? null : this.stopKeyframe
    if (!kf) {
      kf = {
        rgba32: new Uint32Array(g.w * g.h),
        width: g.w,
        height: g.h,
        x,
        y,
        valid: new Uint8Array(g.mw * g.mh),
        fresh: new Float32Array(g.lw * g.lh),
        settled: 0,
        key,
      }
      this.stopKeyframe = this.keyframes.add(kf) ? kf : null
      if (!this.stopKeyframe) return
    }
    // The latest frame of a stop is the most settled one: it replaces the earlier ones.
    // (The pixels may have been given up for memory; then `key` says where to get them.)
    kf.rgba32?.set(rgba32)
    kf.key = key
    kf.valid.set(g.validTmp.subarray(0, g.mw * g.mh))
    kf.fresh!.set(g.fresh)
    kf.settled = this.stillTime
    kf.x = x
    kf.y = y
  }

  /**
   * What a still at (x, y) can contribute, for planPatches: where it has its core
   * (see STILL_CORE_DISTANCE) and where it shows anything at all, with the HUD and
   * content that had only just scrolled into view left out.
   */
  private planFrame(
    g: Geometry,
    x: number,
    y: number,
    valid: Uint8Array | null,
    fresh: Float32Array | null,
    weight: number,
  ): PlanFrame {
    this.buildValidity(g, valid, true)
    this.validityDirty = true
    const cols = Math.ceil(g.w / PLAN_CELL)
    const rows = Math.ceil(g.h / PLAN_CELL)
    const core = new Uint8Array(cols * rows)
    const reach = new Uint8Array(cols * rows)
    for (let cy = 0; cy < rows; cy++) {
      const py = Math.min(g.h - 1, cy * PLAN_CELL + (PLAN_CELL >> 1))
      for (let cx = 0; cx < cols; cx++) {
        const px = Math.min(g.w - 1, cx * PLAN_CELL + (PLAN_CELL >> 1))
        const i = py * g.w + px
        if (g.q[i] === 0) continue
        reach[cy * cols + cx] = 1
        const settled = fresh ? fresh[Math.min(g.lh - 1, (py / g.s) | 0) * g.lw + Math.min(g.lw - 1, (px / g.s) | 0)] : 1
        if (g.rate[i] >= RATING_CORE && settled > 0.98) core[cy * cols + cx] = 1
      }
    }
    return { x, y, cols, rows, core, reach, weight }
  }

  /** Fills the per-frame buffers (luma, quality, rating, lighting) for a still frame. */
  private prepareStill(g: Geometry, rgba32: Uint32Array, valid: Uint8Array | null): void {
    const n = g.w * g.h
    rgba32ToLuma(rgba32, g.lum, n)
    downscaleBox(g.lum, g.w, g.ms, g.maskLumCur, g.mw, g.mh)
    downscaleBoxF32(g.maskLumCur, g.mw, g.ls, g.low, g.lw, g.lh)
    this.buildValidity(g, valid, true)
    g.computeShade(this.mosaic.vignette)
    // The buffers no longer describe the live frame's validity.
    this.validityDirty = true
  }

  /** Draws a still frame into `mosaic`. Call prepareStill() for it first. */
  private compositeStill(
    g: Geometry,
    mosaic: Mosaic,
    rgba32: Uint32Array,
    x: number,
    y: number,
    opts: {
      fresh?: Float32Array | null
      settled?: number
      /**
       * 'join': with a routed border (Mosaic.assemble; between prepareAssembly and
       * finishAssembly). 'fill': only where the map has nothing. 'plain' (default):
       * pixel by pixel to the better-rated view, for scratch maps that are only matched against.
       */
      mode?: 'join' | 'fill' | 'plain'
      skipLight?: boolean
      /** Overrides the quality factor derived from `settled`. */
      quality?: number
      /** For 'join': see Keyframe.suspects. */
      suspects?: ReadonlyArray<WorldBox>
    },
  ) {
    const input = {
      rgba32,
      lum: g.lum,
      q: g.q,
      width: g.w,
      height: g.h,
      x,
      y,
      shade: g.shade,
      shadeWeight: g.shadeWeight,
      shadeW: g.lw,
      shadeH: g.lh,
      shadeScale: g.s,
      fresh: opts.fresh ?? undefined,
      speedFactor: opts.quality ?? ((opts.settled ?? Infinity) >= STILL_SETTLE ? 1 : STILL_BASE_QUALITY),
      confirm: false,
      skipLight: opts.skipLight,
    }
    if (opts.mode === 'join') return mosaic.assemble({ ...input, rating: g.rate, suspects: opts.suspects })
    return mosaic.composite({ ...input, mode: opts.mode === 'fill' ? 'fill' : 'full', assemble: true })
  }

  private afterBatch(): void {
    this.validityDirty = true
    this.lastDrawn = null
    this.lastConfirm = null
    this.statsAge = 0
    const s = this.mosaic.stats()
    this.weak = s.covered > 0 ? s.weak / s.covered : 0
    this.soft = s.covered > 0 ? s.soft / s.covered : 0
  }

  private rebuilding: { frames: Keyframe[]; order: number[]; seam: number; bad: number } | null = null
  /** Which pixels of the frame the stop the camera is at has put into the map (see CompositeInput.own). */
  private stopOwn = new Uint8Array(0)
  /** False once the camera has moved: `stopOwn` is of an earlier stop. */
  private stopOwnCurrent = false
  /** Sharpness of the sharpest frame drawn of the stop the camera is at (see STOP_MIN_SHARPNESS). */
  private stopSharpness = 0
  /** The stop the camera is at has its picture (see STOP_SETTLED). */
  private stopDone = false
  /** Full draws since the camera last stood still (see FINE_STEPS_AFTER_STOP). */
  private fullsSinceStop = 0
  /** Seconds into the stop at which its picture was last drawn, and how many screen cells were settled then. */
  private stopDrawnAt = 0
  private stopSettledCells = 0

  /**
   * Rebuilds the map from the still frames kept so far, in as few and as large patches
   * as possible (see planPatches).
   *
   * While capturing, the map is put together from whatever frame was best for each
   * spot at the time, so it ends up as many small pieces from many moments, and since
   * the camera has perspective, pieces from different moments don't quite fit: belts
   * and pipes come out broken. Once the whole area has been seen, a few stills cover
   * most of it. Each is laid in as one large patch, and the borders between patches
   * are routed around belts, pipes and machines instead of through them (see
   * Mosaic.assemble).
   *
   * A still owns its core outright. Its margin, where the game hides facility icons,
   * only replaces what was itself captured at a screen edge. What no still shows
   * keeps what the capture pass put together. The lighting layer is kept as it is.
   *
   * This is the all-at-once form, for stills whose pixels are in memory. A caller that
   * can read frames from the source again uses rebuildBegin / rebuildPatch / rebuildEnd.
   *
   * @returns null when there is nothing to rebuild from
   */
  rebuildFromStills(debug?: { beforeFinish?: () => void }): RebuildResult | null {
    const plan = this.rebuildBegin(false)
    if (!plan) return null
    for (let i = 0; i < plan.patches.length; i++) this.rebuildPatch(i)
    return this.rebuildEnd(debug)
  }

  /**
   * Starts a rebuild: chooses the stills to rebuild from.
   * @param canFetch whether stills whose pixels were dropped can be read again; if
   *   not, the rebuild makes do with those in memory
   * @returns null when there is nothing to rebuild from, or nothing was captured since
   *   the last rebuild (doing it again could only lose what stills that are gone by
   *   now contributed)
   */
  rebuildBegin(canFetch: boolean): RebuildPlan | null {
    const g = this.g
    if (!g || this.mosaic.isEmpty || !this.unassembled) return null
    const frames = this.keyframes.frames.filter(
      (k) => k.width === g.w && k.height === g.h && (k.rgba32 !== null || (canFetch && k.key !== null)),
    )
    if (frames.length === 0) return null
    // Of two stops at the same place, the one the camera rested at longer is the sharper.
    const plan = planPatches(frames.map((k) => this.planFrame(g, k.x, k.y, k.valid, k.fresh, Math.min(k.settled, 2))))
    this.rebuilding = { frames, order: plan.patches, seam: 0, bad: 0 }
    this.mosaic.prepareAssembly()
    return {
      stills: frames.length,
      patches: plan.patches.map((i) => ({
        key: frames[i].key,
        inMemory: frames[i].rgba32 !== null,
        x: frames[i].x,
        y: frames[i].y,
        suspects: frames[i].suspects?.length ?? 0,
      })),
    }
  }

  /**
   * Lays in patch `i` of the plan.
   * @param pixels the frame, for a patch that is not in memory
   * @returns false if the patch had to be left out (no pixels, or of the wrong size)
   */
  rebuildPatch(i: number, pixels?: StillImage): boolean {
    const g = this.g
    const state = this.rebuilding
    if (!g || !state) return false
    const k = state.frames[state.order[i]]
    let rgba32 = k.rgba32
    if (!rgba32 && pixels && pixels.width === g.w && pixels.height === g.h) {
      rgba32 = new Uint32Array(pixels.rgba.buffer, pixels.rgba.byteOffset, g.w * g.h)
    }
    if (!rgba32) return false
    this.prepareStill(g, rgba32, k.valid)
    const r = this.compositeStill(g, this.mosaic, rgba32, k.x, k.y, {
      fresh: k.fresh,
      settled: k.settled,
      skipLight: true,
      mode: 'join',
      suspects: k.suspects,
    })
    state.seam += r.seamLength ?? 0
    state.bad += r.seamThroughConflict ?? 0
    return true
  }

  rebuildEnd(debug?: { beforeFinish?: () => void }): RebuildResult {
    const state = this.rebuilding
    this.rebuilding = null
    debug?.beforeFinish?.()
    const kept = this.mosaic.finishAssembly()
    this.unassembled = false
    // A stop the camera is still at starts over: what it put into the map may be
    // someone else's now.
    this.stopOwnCurrent = false
    this.afterBatch()
    return {
      stills: state ? state.frames.length : 0,
      patches: state ? state.order.length : 0,
      keptPixels: kept,
      seamLength: state ? state.seam : 0,
      seamThroughConflict: state ? state.bad : 0,
    }
  }

  /**
   * Stitches still images (screenshots) into the map.
   *
   * Unlike video there is no motion to follow, so every image is located by searching
   * for where it fits among the others; it has to overlap them by about a quarter.
   * The order of the images does not matter. The HUD is learned from the images
   * themselves: it is whatever stays in the same place on screen while the world
   * behind it differs from image to image.
   *
   * A map made of nothing but screenshots is put together again from all of them
   * whenever more arrive, so images can be added one at a time: the second one is
   * what makes it possible to tell the HUD in the first. A map that also holds video
   * is only added to.
   */
  stitchImages(images: StillImage[]): ImageStitchResult {
    const result: ImageStitchResult = { total: images.length, placed: 0, skipped: [], hudLearned: false }
    if (images.length === 0) return result
    const first = images[0]
    let geometry = this.g
    if (!geometry || (this.mosaic.isEmpty && (geometry.w !== first.width || geometry.h !== first.height))) {
      geometry = this.g = new Geometry(first.width, first.height)
      this.keyframes.clear()
      this.stopKeyframe = null
      this.stillMask = null
      this.validityDirty = true
      this.hasRef = false
      this.prevValid = false
      this.maskVersion++
    }
    const g = geometry
    const W = g.w
    const H = g.h
    type Point = { x: number; y: number }
    /** One screenshot: new in this call (`input` ≥ 0), or on the map from an earlier one. */
    interface Member {
      rgba32: Uint32Array
      input: number
      pos: Point | null
      /** Luma at mask scale, vignette removed (only for the images the HUD is learned from). */
      lum: Float32Array | null
    }
    const redraw = !this.videoDrawn && this.keyframes.evicted === 0
    const members: Member[] = []
    if (redraw) {
      for (const k of this.keyframes.frames) {
        if (k.settled === Infinity && k.rgba32 && k.width === W && k.height === H) {
          members.push({ rgba32: k.rgba32, input: -1, pos: { x: k.x, y: k.y }, lum: null })
        }
      }
    }
    const known = members.slice()
    const fresh: Member[] = []
    images.forEach((im, i) => {
      if (im.width === W && im.height === H) {
        fresh.push({ rgba32: new Uint32Array(im.rgba.buffer, im.rgba.byteOffset, W * H), input: i, pos: null, lum: null })
      } else {
        result.skipped.push({ index: i, reason: `It is ${im.width}×${im.height}; the map is built from ${W}×${H} frames.` })
      }
    })
    members.push(...fresh)
    const notHud = (mask: Uint8Array | null) => (mask ? mask.map((v) => (v ? 0 : 1)) : null)
    const union = (a: Uint8Array | null, b: Uint8Array | null) => {
      if (!a || !b) return a ?? b
      const out = a.slice()
      for (let k = 0; k < out.length; k++) out[k] |= b[k]
      return out
    }
    const learnHud = members.length >= 2 && this.settings.autoUiMask
    const before = this.stillMask

    // ---- 0. a first guess at the HUD, before anything is placed
    // Whatever is pixel-for-pixel the same in screenshots of different places is
    // probably HUD. Left in, it would vote for "these two images are in the same place"
    // when the images are matched against each other.
    const ordered = [...fresh, ...known]
    const subset =
      ordered.length <= STILL_MASK_IMAGES
        ? ordered
        : fresh.length >= STILL_MASK_IMAGES
          ? fresh.filter((_, k) => k % Math.ceil(fresh.length / STILL_MASK_IMAGES) === 0)
          : ordered.slice(0, STILL_MASK_IMAGES)
    let guess: Uint8Array | null = null
    if (learnHud) {
      for (const m of subset) {
        rgba32ToLuma(m.rgba32, g.lum, W * H)
        downscaleBox(g.lum, W, g.ms, g.maskLumCur, g.mw, g.mh)
        g.flattenMaskLum(this.mosaic.vignette)
        m.lum = g.maskLumCur.slice()
      }
      const votes = new StillHudVotes(g.mw, g.mh)
      for (let k = 0; k < subset.length; k++) {
        for (let j = 1; j <= Math.min(STILL_MASK_NEIGHBOURS, subset.length - 1); j++) {
          const a = subset[k].lum!
          const b = subset[(k + j) % subset.length].lum!
          // Two screenshots of the same view say nothing about what is HUD.
          if (!sameView(a, b)) votes.observe(a, b, null)
        }
      }
      if (votes.pairs > 0) {
        guess = new Uint8Array(g.mw * g.mh)
        votes.staticMask(guess)
      }
    }

    // ---- 1. where is each image?
    // Images are located against a scratch map, so that nothing reaches the real map
    // before the HUD is known.
    /** Images located on the existing map (which has no HUD in it): no second check needed. */
    const anchored = new Set<Member>()
    const scratch = new Mosaic()
    scratch.vignette.set(this.mosaic.vignette)
    scratch.learnVignette = false
    let valid = notHud(before)
    // For matching, an image leaves out everything the guess says may be HUD...
    const matchable = notHud(union(before, guess))
    // ...but goes into the scratch map with only the solid parts of the guess (panels)
    // left out: the scattered chance matches would riddle it with holes.
    let solid: Uint8Array | null = null
    if (guess) {
      solid = guess.slice()
      const tmp = new Uint8Array(solid.length)
      erode(solid, g.mw, g.mh, 2, tmp)
      dilate(solid, g.mw, g.mh, 3, tmp)
    }
    const placeable = notHud(union(before, solid))
    const place = (m: Member, p: Point) => {
      m.pos = p
      this.prepareStill(g, m.rgba32, placeable)
      this.compositeStill(g, scratch, m.rgba32, p.x, p.y, {})
    }
    for (const m of known) place(m, m.pos!)
    if (this.mosaic.isEmpty) {
      if (fresh.length > 0) place(fresh[0], { x: 0, y: 0 })
    } else if (!redraw) {
      for (const m of fresh) {
        this.prepareStill(g, m.rgba32, matchable)
        const hit = this.locate(g, this.mosaic, true)
        if (!hit) continue
        anchored.add(m)
        place(m, hit)
      }
      if (anchored.size === 0) {
        for (const m of fresh) {
          result.skipped.push({
            index: m.input,
            reason: 'It does not overlap the map (about a quarter is needed). Clear the map to start a new one.',
          })
        }
        this.afterBatch()
        return result
      }
    }
    for (let progress = true; progress; ) {
      progress = false
      for (const m of fresh) {
        if (m.pos) continue
        this.prepareStill(g, m.rgba32, matchable)
        const hit = this.locate(g, scratch, false)
        if (!hit) continue
        place(m, hit)
        progress = true
      }
    }

    // ---- 2. what is HUD? Now with positions: where two images show the same piece of
    // the world, whatever differs between them and stays put on screen is HUD.
    const learn = (): void => {
      const located = subset.filter((m) => m.pos)
      if (!learnHud || located.length < 2) return
      const votes = new StillHudVotes(g.mw, g.mh)
      for (const a of located) {
        const pa = a.pos!
        const near = located
          .filter((b) => b !== a)
          .sort((b, c) => distance(b.pos!, pa) - distance(c.pos!, pa))
          .slice(0, STILL_MASK_NEIGHBOURS)
        for (const b of near) {
          if (sameView(a.lum!, b.lum!)) continue
          votes.observe(a.lum!, b.lum!, {
            dx: Math.round((b.pos!.x - pa.x) / g.ms),
            dy: Math.round((b.pos!.y - pa.y) / g.ms),
          })
        }
      }
      const mask = new Uint8Array(g.mw * g.mh)
      votes.computeMask(mask)
      // A map that is redrawn from all its images gets the mask they give; otherwise
      // what was masked when the earlier images went in stays masked.
      this.stillMask = redraw ? mask : union(mask, before)
      valid = notHud(this.stillMask)
      result.hudLearned = true
    }
    learn()

    // ---- 2b. check every placement, now that the HUD is out of the way
    // The first round accepted an image wherever it fitted best by a clear margin,
    // although the match itself was weak (the other images' HUD was in the way).
    // With the HUD masked, an image that really belongs there matches its neighbours
    // as well as a video frame matches the map; one that was only the best of a bad
    // lot does not, and is taken out again.
    let rejected = 0
    for (const m of fresh) {
      const pm = m.pos
      if (!pm || anchored.has(m)) continue
      const placedCount = members.filter((o) => o.pos).length
      const near = members
        .filter((o) => o !== m && o.pos && Math.abs(o.pos.x - pm.x) < W && Math.abs(o.pos.y - pm.y) < H)
        .sort((a, b) => distance(a.pos!, pm) - distance(b.pos!, pm))
        .slice(0, 2)
      if (near.length === 0) {
        // Nothing else placed touches it. Fine if it is the only image there is.
        if (placedCount > 1) {
          m.pos = null
          rejected++
        }
        continue
      }
      const local = new Mosaic()
      local.vignette.set(this.mosaic.vignette)
      local.learnVignette = false
      for (const o of near) {
        this.prepareStill(g, o.rgba32, valid)
        this.compositeStill(g, local, o.rgba32, o.pos!.x, o.pos!.y, {})
      }
      this.prepareStill(g, m.rgba32, valid)
      selectSamples(g.lum, g.q, W, H, 5, 10, this.samples, { shade: g.shade, w: g.lw, h: g.lh, scale: g.s })
      const res = this.refineAt(g, pm.x, pm.y, g.s + 3, 2500, local)
      if (res && res.score >= MIN_MATCH_SCORE && Math.abs(res.dx) <= 2 && Math.abs(res.dy) <= 2) {
        m.pos = { x: pm.x + res.dx, y: pm.y + res.dy }
      } else {
        m.pos = null
        rejected++
      }
    }
    // The HUD was learned with the rejected images in the mix: do it again without.
    if (rejected > 0) learn()
    if (this.stillMask !== before) this.maskVersion++
    for (const m of fresh) {
      if (!m.pos) {
        result.skipped.push({
          index: m.input,
          reason: 'It does not overlap the other images enough (about a quarter is needed).',
        })
      }
    }

    // ---- 3. draw them, largest contribution first
    const placed = fresh.filter((m) => m.pos)
    const drawn = redraw ? members.filter((m) => m.pos) : placed
    if (redraw) {
      this.mosaic.clear()
      this.keyframes.clear()
    } else {
      this.mosaic.prepareAssembly()
    }
    // Screenshots all have the same usable area: work it out once.
    const usable = this.planFrame(g, 0, 0, valid, null, 1)
    const plan = planPatches(drawn.map((m) => ({ ...usable, x: m.pos!.x, y: m.pos!.y })))
    const draw = (m: Member, mode: 'join' | 'fill') => {
      const p = m.pos!
      this.prepareStill(g, m.rgba32, valid)
      this.compositeStill(g, this.mosaic, m.rgba32, p.x, p.y, { mode })
      this.keyframes.add({
        rgba32: m.rgba32,
        width: W,
        height: H,
        x: p.x,
        y: p.y,
        valid: valid ? valid.slice() : new Uint8Array(g.mw * g.mh).fill(1),
        fresh: null,
        settled: Infinity,
        key: null,
      })
    }
    for (const k of plan.patches) draw(drawn[k], 'join')
    for (const k of plan.fillers) draw(drawn[k], 'fill')
    // Last resort: where the only pictures there are of a spot have HUD over it, show
    // that rather than a hole. It is stored with next to no quality, so it shows up as
    // low confidence and anything better replaces it.
    for (const m of drawn) {
      const p = m.pos!
      this.prepareStill(g, m.rgba32, null)
      if (this.mosaic.countMissing(p.x, p.y, W, H, g.q) < MIN_MISSING) continue
      this.compositeStill(g, this.mosaic, m.rgba32, p.x, p.y, { mode: 'fill', quality: LAST_RESORT_QUALITY, skipLight: true })
    }
    this.mosaic.finishAssembly()
    result.placed = placed.length

    // A capture that follows starts by finding out where it is.
    if (placed.length > 0) {
      const last = placed[placed.length - 1].pos!
      this.lastX = last.x
      this.lastY = last.y
    }
    this.hasRef = false
    this.prevValid = false
    this.stillFrames = 0
    this.afterBatch()
    return result
  }

  /**
   * A status for moments when no frame is being processed (after stitching images or
   * rebuilding): the map's figures are current, the per-frame ones are empty.
   */
  idleStatus(): FrameStatus | null {
    const g = this.g
    if (!g) return null
    return {
      state: 'tracking',
      calibration: 1,
      frameIndex: this.frameIndex,
      x: this.lastX,
      y: this.lastY,
      width: g.w,
      height: g.h,
      speed: 0,
      matchScore: null,
      composited: false,
      drawMode: null,
      disagreement: 0,
      weak: this.weak,
      soft: this.soft,
      keyframes: this.keyframes.frames.length,
      maskVersion: this.maskVersion,
      tileCount: this.mosaic.tiles.size,
      processMs: 0,
      timings: {},
    }
  }

  /** HUD mask learned from still images (1 = HUD) at mask scale, if any. */
  getStillMask(): Uint8Array | null {
    return this.stillMask
  }

  /**
   * Where the prepared frame is on `mosaic`, found by a search of the whole map.
   * @param strict demand as good a match as for video; otherwise a weak match that
   *   clearly stands out is enough (see STILL_MIN_SCORE)
   */
  private locate(g: Geometry, mosaic: Mosaic, strict: boolean): { x: number; y: number } | null {
    selectSamples(g.lum, g.q, g.w, g.h, 5, 10, this.samples, { shade: g.shade, w: g.lw, h: g.lh, scale: g.s })
    const minScore = strict ? MIN_MATCH_SCORE : STILL_MIN_SCORE
    const hit = this.relocalize(g, mosaic, STILL_MIN_OVERLAP, minScore, strict ? RELOC_MARGIN : STILL_MARGIN)
    if (!hit) return null
    const res = this.refineAt(g, hit.x, hit.y, g.s + 3, 2500, mosaic)
    if (!res || res.score < minScore) return null
    return { x: hit.x + res.dx, y: hit.y + res.dy }
  }

  /** Extracts the map around (px, py) ± radius and searches the best offset there. */
  private refineAt(
    g: Geometry,
    px: number,
    py: number,
    radius: number,
    coarseSamples: number,
    mosaic: Mosaic = this.mosaic,
  ): RefineResult | null {
    const regionW = g.w + 2 * radius
    const regionH = g.h + 2 * radius
    if (this.region.length < regionW * regionH) {
      this.region = new Uint8Array(regionW * regionH)
      this.regionQ = new Uint8Array(regionW * regionH)
    }
    mosaic.extract(px - radius, py - radius, regionW, regionH, this.region, this.regionQ)
    return refineOffset(this.samples, this.region, this.regionQ, regionW, radius, coarseSamples)
  }

  /**
   * Global search: coarse candidates from the thumbnail map, each verified with a
   * full-resolution search. Returns the winning position, or null when nothing is
   * convincing (or two different places look equally good).
   */
  private relocalize(
    g: Geometry,
    mosaic: Mosaic = this.mosaic,
    minOverlap?: number,
    minScore = MIN_MATCH_SCORE,
    margin = RELOC_MARGIN,
  ): { x: number; y: number } | null {
    const candidates = this.relocalizer.findCandidates(mosaic, g.lum, g.q, g.w, g.h, 6, minOverlap)
    let best: { x: number; y: number; score: number } | null = null
    let runnerUp = -Infinity
    const r = 40 // > THUMB_SCALE: covers the thumbnail grid's quantisation
    for (const c of candidates) {
      const res = this.refineAt(g, c.x, c.y, r, 800, mosaic)
      if (!res) continue
      const hit = { x: c.x + res.dx, y: c.y + res.dy, score: res.score }
      if (!best || hit.score > best.score) {
        if (best && (Math.abs(best.x - hit.x) > 8 || Math.abs(best.y - hit.y) > 8)) runnerUp = Math.max(runnerUp, best.score)
        best = hit
      } else if (Math.abs(best.x - hit.x) > 8 || Math.abs(best.y - hit.y) > 8) {
        runnerUp = Math.max(runnerUp, hit.score)
      }
    }
    if (!best || best.score < minScore || best.score - runnerUp < margin) return null
    return best
  }

  /** Crop + HUD mask → per-pixel quality map, lighting weights and the low-res validity mask. */
  private recomputeValidity(g: Geometry): void {
    this.buildValidity(g, null, false)
    this.validityDirty = false
  }

  /**
   * @param extra further exclusions at mask scale (1 = usable), or null
   * @param still the frame is a still about to be joined to others: its core is the
   *   measured one (STILL_CORE_DISTANCE), and `g.rate` is filled in as well
   */
  private buildValidity(g: Geometry, extra: Uint8Array | null, still: boolean): void {
    const { w, h, ms, mw, mh, uiMask, validTmp: valid, dist, q } = g
    const c = this.settings.crop
    const x0 = Math.round(c.left * w)
    const x1 = Math.max(x0 + 1, w - Math.round(c.right * w))
    const y0 = Math.round(c.top * h)
    const y1 = Math.max(y0 + 1, h - Math.round(c.bottom * h))
    const useMask = this.settings.autoUiMask

    // Distance to the nearest excluded pixel, computed at mask scale (ms² times cheaper
    // than full resolution; quality only needs to be smooth, not pixel-exact).
    const half = ms >> 1
    for (let my = 0; my < mh; my++) {
      const cy = my * ms + half
      for (let mx = 0; mx < mw; mx++) {
        const cx = mx * ms + half
        const i = my * mw + mx
        valid[i] =
          cx >= x0 && cx < x1 && cy >= y0 && cy < y1 && !(useMask && uiMask[i]) && !(extra && !extra[i]) ? 1 : 0
      }
    }
    distanceTransform(valid, mw, mh, dist)
    // `dist` is in thirds of a mask pixel.
    const short = Math.min(x1 - x0, y1 - y0)
    const unit = (short / ms) * 3
    const lightRamp = Math.max(1, LIGHT_RAMP * unit)
    // Quality by distance from the nearest excluded pixel: edge feather, margin, core.
    const core = Math.max(2, (still ? STILL_CORE_DISTANCE : CORE_DISTANCE) * unit)
    const edge = Math.max(1, EDGE_FEATHER * unit)
    const step = Math.max(1, ZONE_STEP * unit)
    const lut = this.qualityByDistance
    const rateLut = this.ratingByDistance
    for (let d = 0; d < lut.length; d++) {
      let v: number
      if (d >= core) v = 1
      else if (d > core - step) {
        const t = (d - (core - step)) / step
        v = MARGIN_QUALITY + (1 - MARGIN_QUALITY) * t * t * (3 - 2 * t)
      } else v = MARGIN_QUALITY * Math.min(1, d / edge)
      lut[d] = Math.max(1, Math.round(255 * v))
      // 0 = in the core (rated by distance from the centre, below).
      rateLut[d] = d >= core ? 0 : Math.max(1, Math.floor(((RATING_CORE - 1) * d) / core))
    }
    const lutMax = lut.length - 1
    const rate = g.rate
    if (still) rate.fill(0)

    q.fill(0)
    // (The centre of the screen is where the camera looks straight down.)
    const cx = w / 2
    const cy = h / 2
    const fall = (255 - RATING_CORE) / Math.hypot(cx, cy)
    if (!still) {
      // The quality is the same for all pixels of a mask cell: worked out once per cell
      // and spread over its pixels, and a row of pixels in the same mask row as the one
      // above is a copy of that. (This runs whenever the HUD mask changes, which while
      // it is being learned is every few frames.)
      if (this.cellOfColumn.length !== w) this.cellOfColumn = new Int32Array(w)
      if (this.cellQuality.length < mw) this.cellQuality = new Uint8Array(mw)
      const { cellOfColumn, cellQuality } = this
      for (let x = 0; x < w; x++) cellOfColumn[x] = Math.min(mw - 1, (x / ms) | 0)
      let lastCellRow = -1
      let lastRow = 0
      for (let y = y0; y < y1; y++) {
        const my = Math.min(mh - 1, (y / ms) | 0)
        const row = y * w
        if (my === lastCellRow) {
          q.copyWithin(row + x0, lastRow + x0, lastRow + x1)
          continue
        }
        const mrow = my * mw
        for (let mx = 0; mx < mw; mx++) {
          const mi = mrow + mx
          cellQuality[mx] =
            (useMask && uiMask[mi]) || (extra && !extra[mi]) ? 0 : lut[dist[mi] < lutMax ? dist[mi] : lutMax]
        }
        for (let x = x0; x < x1; x++) q[row + x] = cellQuality[cellOfColumn[x]]
        lastCellRow = my
        lastRow = row
      }
    } else {
      for (let y = y0; y < y1; y++) {
        const mrow = Math.min(mh - 1, (y / ms) | 0) * mw
        const row = y * w
        const dy2 = (y - cy) * (y - cy)
        for (let x = x0; x < x1; x++) {
          const mi = mrow + Math.min(mw - 1, (x / ms) | 0)
          if ((useMask && uiMask[mi]) || (extra && !extra[mi])) continue
          const d = dist[mi] < lutMax ? dist[mi] : lutMax
          q[row + x] = lut[d]
          const r = rateLut[d]
          rate[row + x] = r !== 0 ? r : (255.5 - fall * Math.sqrt((x - cx) * (x - cx) + dy2)) | 0
        }
      }
    }

    const { s, lw, lh, lowValid, shadeWeight } = g
    const lhalf = s >> 1
    for (let by = 0; by < lh; by++) {
      const cy = by * s + lhalf
      const mrow = Math.min(mh - 1, (cy / ms) | 0) * mw
      for (let bx = 0; bx < lw; bx++) {
        const cx = bx * s + lhalf
        const i = by * lw + bx
        const ok = valid[mrow + Math.min(mw - 1, (cx / ms) | 0)] !== 0
        lowValid[i] = ok ? 1 : 0
        // Smoothstep feather: frames fade into the lighting layer instead of stamping it.
        const t = ok ? Math.min(1, dist[mrow + Math.min(mw - 1, (cx / ms) | 0)] / lightRamp) : 0
        shadeWeight[i] = t * t * (3 - 2 * t)
      }
    }
    g.correlator.setWindowRect({
      x: Math.floor(x0 / s),
      y: Math.floor(y0 / s),
      w: Math.max(1, Math.floor(x1 / s) - Math.floor(x0 / s)),
      h: Math.max(1, Math.floor(y1 / s) - Math.floor(y0 / s)),
    })
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Whether two mask-scale images are (nearly) the same picture. */
function sameView(a: Float32Array, b: Float32Array): boolean {
  let same = 0
  let n = 0
  for (let i = 0; i < a.length; i += 7) {
    if (Math.abs(a[i] - b[i]) <= 2) same++
    n++
  }
  return same > 0.6 * n
}

/**
 * How sharp a frame is: the mean brightness step between neighbouring pixels, over
 * what is usable of it. Only meaningful between frames showing the same view.
 */
function sharpness(lum: Uint8Array, q: Uint8Array, w: number, h: number): number {
  let sum = 0
  let n = 0
  for (let y = 1; y < h - 1; y += 2) {
    const row = y * w
    for (let x = 1; x < w - 1; x += 2) {
      const i = row + x
      if (q[i] === 0) continue
      const v = lum[i]
      const dx = lum[i + 1] - v
      const dy = lum[i + w] - v
      sum += (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)
      n++
    }
  }
  return n > 0 ? sum / n : 0
}
