import { it } from 'vitest'
import { distanceTransform, downscaleBox, rgbaToLuma } from './image'
import { PhaseCorrelator } from './phaseCorrelation'
import { refineOffset, SampleSet, selectSamples } from './refine'
import { UiMaskEstimator } from './uiMask'
import { DEFAULT_SETTINGS, Stitcher } from './stitcher'
import { makeWorld, renderFrame } from './synthetic'

it.runIf(!!process.env.BENCH)('bench 1080p stages', () => {
  const W = 1920, H = 1080
  const world = makeWorld(3000, 2000, 2)
  const frames = Array.from({ length: 40 }, (_, i) => renderFrame(world, 100 + i * 15, 100 + i * 5, W, H, 1, 0))
  const t = (name: string, fn: () => void, n = 10) => {
    fn()
    const t0 = performance.now()
    for (let i = 0; i < n; i++) fn()
    console.log(`${name}: ${((performance.now() - t0) / n).toFixed(2)} ms`)
  }
  const lum = new Uint8Array(W * H)
  t('luma', () => rgbaToLuma(frames[0], lum, W * H))
  const low = new Float32Array(240 * 135)
  t('downscale s=8', () => downscaleBox(lum, W, 8, low, 240, 135))
  const ml = new Float32Array(640 * 360)
  t('downscale s=3', () => downscaleBox(lum, W, 3, ml, 640, 360))
  const pc = new PhaseCorrelator(240, 135)
  const a = pc.createSpectrum(), b = pc.createSpectrum()
  t('spectrum', () => pc.computeSpectrum(low, null, a))
  pc.computeSpectrum(low, null, b)
  t('correlate', () => pc.correlate(a, b))
  const valid = new Uint8Array(W * H).fill(1)
  const dist = new Uint16Array(W * H)
  t('distanceTransform', () => distanceTransform(valid, W, H, dist), 3)
  const est = new UiMaskEstimator(640, 360)
  t('mask observe', () => est.observe(ml, ml, 3, 1))
  const m = new Uint8Array(640 * 360)
  t('mask compute', () => est.computeMask(m))
  const q = new Uint8Array(W * H).fill(200)
  const ss = new SampleSet()
  const field = { shade: new Float32Array([100]), w: 1, h: 1, scale: W }
  t('selectSamples', () => selectSamples(lum, q, W, H, 4, 10, ss, field))
  console.log('samples', ss.count)
  const r = 11, rw = W + 2 * r, rh = H + 2 * r
  const region = new Uint8Array(rw * rh), rq = new Uint8Array(rw * rh).fill(1)
  t('refine r=11', () => refineOffset(ss, region, rq, rw, r))
  const s = new Stitcher({ ...DEFAULT_SETTINGS, autoUiMask: false })
  let total = 0
  const acc: Record<string, number> = {}
  frames.forEach((f, i) => {
    const st = s.process({ rgba: f, width: W, height: H, timestamp: i * 33 })
    if (i > 5) {
      total += st.processMs
      for (const [k, v] of Object.entries(st.timings)) acc[k] = (acc[k] ?? 0) + v
    }
  })
  const n = frames.length - 6
  console.log(`full process avg: ${(total / n).toFixed(1)} ms`, Object.entries(acc).map(([k, v]) => `${k}=${(v / n).toFixed(1)}`).join(' '))
}, 600000)
