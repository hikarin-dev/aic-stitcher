import { it } from 'vitest'
import { Mosaic } from './mosaic'
import { makeWorld, renderFrame } from './synthetic'

it.runIf(!!process.env.BENCH)('bench composite 2560', () => {
  const W = 2560
  const H = 1440
  const world = makeWorld(4000, 2400, 3)
  const m = new Mosaic()
  const q = new Uint8Array(W * H).fill(200)
  const lum = new Uint8Array(W * H)
  const gain = new Uint16Array([256])
  let t = 0
  for (let i = 0; i < 12; i++) {
    const rgba = renderFrame(world, 100 + i * 40, 100 + i * 7, W, H, 1 + 0.1 * Math.sin(i), 0)
    for (let k = 0; k < W * H; k++) lum[k] = (rgba[k * 4] * 77 + rgba[k * 4 + 1] * 150 + rgba[k * 4 + 2] * 29) >> 8
    const t0 = performance.now()
    m.composite({ rgba32: new Uint32Array(rgba.buffer), lum, q, width: W, height: H, x: i * 40, y: i * 7, gain, gainW: 1, gainH: 1, gainScale: W, speedFactor: 0.8, confirm: true })
    if (i >= 2) t += performance.now() - t0
  }
  console.log(`composite 2560x1440: ${(t / 10).toFixed(1)} ms`)
}, 600000)
