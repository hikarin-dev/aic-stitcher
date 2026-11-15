import { GainEstimator } from './gain'
import { distanceTransform, downscaleBox, downscaleBoxF32, rgbaToLuma, type Pixels } from './image'
import { Mosaic } from './mosaic'
import { PhaseCorrelator, type Spectrum } from './phaseCorrelation'
import { refineOffset, SampleSet, selectSamples, type RefineResult } from './refine'
import { Relocalizer } from './relocalize'
import { UiMaskEstimator } from './uiMask'

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
  /** Compensate brightness changes (cloud shadows etc). */
  lightingCorrection: boolean
  /** Frames whose camera moves faster than this (px/s) are tracked but not drawn. 0 = no limit. */
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
  /** Current global lighting gain relative to the map. */
  gain: number
  composited: boolean
  /** Bumped every time the UI mask changes. */
  maskVersion: number
  tileCount: number
  processMs: number
  /** Per-stage timings in ms (for the debug panel). */
  timings: Record<string, number>
}

export interface FrameInput {
  rgba: Pixels
  width: number
  height: number
  /** Milliseconds, monotonic. */
  timestamp: number
}

/** Motion-voting frames needed before we trust the HUD mask enough to draw. */
const CALIBRATION_FRAMES = 24
const MIN_MATCH_SCORE = 0.55
/** A relocalization must beat the runner-up by this much to be trusted (repetitive factories). */
const RELOC_MARGIN = 0.04
/** Map pixels at/above this quality were captured well inside a frame (see GainInput.minMapQ). */
const HIGH_QUALITY = 160
/** Fraction of the estimated lighting correction that is applied (see GainEstimator.damp). */
const LIGHT_STRENGTH = 0.75
/** Camera speed (px/s) at which a frame's quality is halved. */
const SPEED_HALF_QUALITY = 1500
/** Minimum camera movement between composited frames, as a fraction of the frame's short side. */
const COMPOSITE_STEP = 0.05

/** All per-resolution buffers. Recreated when the capture size changes. */
class Geometry {
  readonly w: number
  readonly h: number
  readonly lum: Uint8Array
  readonly q: Uint8Array
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
  readonly gain: Uint16Array

  // HUD mask scale
  readonly ms: number
  readonly mw: number
  readonly mh: number
  maskLumCur: Float32Array
  maskLumPrev: Float32Array
  readonly uiMask: Uint8Array
  readonly estimator: UiMaskEstimator

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    const n = w * h
    this.lum = new Uint8Array(n)
    this.q = new Uint8Array(n)
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
    this.low = new Float32Array(this.lw * this.lh)
    this.lowValid = new Uint8Array(this.lw * this.lh)
    this.correlator = new PhaseCorrelator(this.lw, this.lh)
    this.specCur = this.correlator.createSpectrum()
    this.specRef = this.correlator.createSpectrum()
    this.gain = new Uint16Array(this.lw * this.lh).fill(256)

    this.maskLumCur = new Float32Array(this.mw * this.mh)
    this.maskLumPrev = new Float32Array(this.mw * this.mh)
    this.uiMask = new Uint8Array(this.mw * this.mh)
    this.estimator = new UiMaskEstimator(this.mw, this.mh)
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
  private lastGain = 1
  private lastComposited = false
  /** Position of the last composited frame (null = none since the last jump/reset). */
  private lastDrawn: { x: number; y: number } | null = null

  private gainEstimator = new GainEstimator()
  private samples = new SampleSet()
  private region = new Uint8Array(0)
  private regionQ = new Uint8Array(0)
  private regionW = 0
  private regionRadius = 0
  private relocalizer = new Relocalizer()

  constructor(settings: StitchSettings = DEFAULT_SETTINGS) {
    this.settings = structuredClone(settings)
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
  }

  /** Clears the map but keeps the learned HUD mask. */
  clearMap(): void {
    this.mosaic.clear()
    this.hasRef = false
    this.prevValid = false
    this.lostFrames = 0
    this.lastX = 0
    this.lastY = 0
    this.lastGain = 1
    this.lastComposited = false
    this.lastDrawn = null
  }

  /** Forgets the learned HUD mask (e.g. after changing the in-game UI layout). */
  resetUiMask(): void {
    if (!this.g) return
    this.g.estimator.reset()
    this.g.uiMask.fill(0)
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
      if (!this.mosaic.isEmpty) this.lostFrames = Math.max(this.lostFrames, 1)
    }
    this.frameIndex++
    const { settings, mosaic } = this

    rgbaToLuma(rgba, g.lum, W * H)
    downscaleBox(g.lum, W, g.ms, g.maskLumCur, g.mw, g.mh)
    downscaleBoxF32(g.maskLumCur, g.mw, g.ls, g.low, g.lw, g.lh)
    mark('preprocess')
    if (this.validityDirty) this.recomputeValidity(g)
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
    if (!mosaic.isEmpty) {
      selectSamples(g.lum, g.q, W, H, 5, 10, this.samples)
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
      const localOk = (refined && refined.score >= MIN_MATCH_SCORE) || (coarse && !refined)
      if (!localOk) {
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
    let fine = false
    if (refined && refined.score >= MIN_MATCH_SCORE) {
      x = predX + refined.dx
      y = predY + refined.dy
      good = true
      fine = true
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
    }

    let composited = false
    let speed = 0
    if (good) {
      const dt = (input.timestamp - this.prevTime) / 1000
      if (this.prevValid && dt > 0) speed = Math.hypot(x - this.prevX, y - this.prevY) / dt
      const moved = !this.prevValid || x !== this.prevX || y !== this.prevY

      // HUD learning from consecutive good frames.
      if (settings.autoUiMask && this.prevValid) {
        const cdx = Math.round((this.prevX - x) / g.ms)
        const cdy = Math.round((this.prevY - y) / g.ms)
        if (Math.max(Math.abs(cdx), Math.abs(cdy)) >= 2) {
          g.estimator.observe(g.maskLumCur, g.maskLumPrev, cdx, cdy)
          this.observationsSinceMask++
          const calibrating = g.estimator.observations <= CALIBRATION_FRAMES
          if (calibrating || this.observationsSinceMask >= 8) {
            g.estimator.computeMask(g.uiMask)
            this.observationsSinceMask = 0
            this.validityDirty = true
            this.maskVersion++
          }
        }
      }

      mark('uiMask')

      // Lighting.
      let gainValue = this.lastGain
      if (!settings.lightingCorrection) {
        gainValue = 1
        this.gainEstimator.setUniform(1)
      } else if (fine && refined) {
        const est = this.gainEstimator.estimate({
          lum: g.lum,
          q: g.q,
          width: W,
          height: H,
          region: this.region,
          regionQ: this.regionQ,
          regionW: this.regionW,
          offX: refined.dx + this.regionRadius,
          offY: refined.dy + this.regionRadius,
          minMapQ: HIGH_QUALITY,
        })
        if (est !== null) gainValue = this.gainEstimator.damp(est, LIGHT_STRENGTH, 0.7, 1.4)
        else this.gainEstimator.setUniform(this.lastGain)
      } else {
        this.gainEstimator.setUniform(this.lastGain)
      }
      this.lastGain = gainValue
      mark('gain')

      // Draw.
      const speedOk = settings.maxSpeed <= 0 || speed <= settings.maxSpeed
      // Compositing is the most expensive step: only do it once the view has moved
      // far enough to show something new (consecutive frames overlap ~95%).
      const minStep = COMPOSITE_STEP * Math.min(W, H)
      const farEnough =
        !this.lastDrawn || Math.max(Math.abs(x - this.lastDrawn.x), Math.abs(y - this.lastDrawn.y)) >= minStep
      if (this.isCalibrated && !settings.paused && speedOk && farEnough && (moved || !this.lastComposited)) {
        if (this.validityDirty) this.recomputeValidity(g)
        mark('validity')
        this.gainEstimator.render(g.gain, g.lw, g.lh, g.s, W, H)
        mosaic.composite({
          rgba32,
          lum: g.lum,
          q: g.q,
          width: W,
          height: H,
          x,
          y,
          gain: g.gain,
          gainW: g.lw,
          gainH: g.lh,
          gainScale: g.s,
          // Fast pans blur and compress worse: such frames count for less and don't
          // confirm what they see (a cursor dragged along would look "confirmed").
          speedFactor: 1 / (1 + speed / SPEED_HALF_QUALITY),
          confirm: speed < SPEED_HALF_QUALITY * 0.5,
        })
        composited = true
        this.lastDrawn = { x, y }
        mark('composite')
      }
      this.lastComposited = composited || (this.lastComposited && !moved)

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
      gain: this.lastGain,
      composited,
      maskVersion: this.maskVersion,
      tileCount: mosaic.tiles.size,
      processMs: performance.now() - t0,
      timings,
    }
  }

  /** Extracts the map around (px, py) ± radius and searches the best offset there. */
  private refineAt(g: Geometry, px: number, py: number, radius: number, coarseSamples: number): RefineResult | null {
    const regionW = g.w + 2 * radius
    const regionH = g.h + 2 * radius
    if (this.region.length < regionW * regionH) {
      this.region = new Uint8Array(regionW * regionH)
      this.regionQ = new Uint8Array(regionW * regionH)
    }
    this.mosaic.extract(px - radius, py - radius, regionW, regionH, this.region, this.regionQ)
    this.regionW = regionW
    this.regionRadius = radius
    return refineOffset(this.samples, this.region, this.regionQ, regionW, radius, coarseSamples)
  }

  /**
   * Global search: coarse candidates from the thumbnail map, each verified with a
   * full-resolution search. Returns the winning position, or null when nothing is
   * convincing (or two different places look equally good).
   */
  private relocalize(g: Geometry): { x: number; y: number } | null {
    const candidates = this.relocalizer.findCandidates(this.mosaic, g.lum, g.q, g.w, g.h)
    let best: { x: number; y: number; score: number } | null = null
    let runnerUp = -Infinity
    const r = 40 // > THUMB_SCALE: covers the thumbnail grid's quantisation
    for (const c of candidates) {
      const res = this.refineAt(g, c.x, c.y, r, 800)
      if (!res) continue
      const hit = { x: c.x + res.dx, y: c.y + res.dy, score: res.score }
      if (!best || hit.score > best.score) {
        if (best && (Math.abs(best.x - hit.x) > 8 || Math.abs(best.y - hit.y) > 8)) runnerUp = Math.max(runnerUp, best.score)
        best = hit
      } else if (Math.abs(best.x - hit.x) > 8 || Math.abs(best.y - hit.y) > 8) {
        runnerUp = Math.max(runnerUp, hit.score)
      }
    }
    if (!best || best.score < MIN_MATCH_SCORE || best.score - runnerUp < RELOC_MARGIN) return null
    return best
  }

  /** Crop + HUD mask → per-pixel quality map and the low-res validity mask. */
  private recomputeValidity(g: Geometry): void {
    this.validityDirty = false
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
        valid[i] = cx >= x0 && cx < x1 && cy >= y0 && cy < y1 && !(useMask && uiMask[i]) ? 1 : 0
      }
    }
    distanceTransform(valid, mw, mh, dist)
    // Quality ramps up over 20% of the crop's short side, then saturates.
    const qMax = Math.max(1, ((0.2 * Math.min(x1 - x0, y1 - y0)) / ms) * 3)
    const k = 254 / qMax

    q.fill(0)
    for (let y = y0; y < y1; y++) {
      const mrow = Math.min(mh - 1, (y / ms) | 0) * mw
      const row = y * w
      for (let x = x0; x < x1; x++) {
        const mi = mrow + Math.min(mw - 1, (x / ms) | 0)
        if (useMask && uiMask[mi]) continue
        q[row + x] = Math.min(255, 1 + ((dist[mi] * k) | 0))
      }
    }

    const { s, lw, lh, lowValid } = g
    const lhalf = s >> 1
    for (let by = 0; by < lh; by++) {
      for (let bx = 0; bx < lw; bx++) {
        lowValid[by * lw + bx] = q[(by * s + lhalf) * w + bx * s + lhalf] > 0 ? 1 : 0
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
