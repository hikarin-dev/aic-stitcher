/**
 * Dev helper, skipped unless DEBUG_OUT is set:
 *   DEBUG_OUT=/some/dir npx vitest run src/stitcher/debug.test.ts --silent=false
 * Writes the reconstructed synthetic map, a sample frame and the quality map as PNGs.
 */
import { it } from 'vitest'
import { DEFAULT_SETTINGS, Stitcher } from './stitcher'
import { TILE_SIZE } from './mosaic'
import { writeMosaicPng, writePng } from './testing/png'
import { ENDFIELD_VIGNETTE } from './mosaic'
import { makeWorld, renderFrame, sweepPath } from './synthetic'

const OUT = process.env.DEBUG_OUT
const LIGHTING = process.env.DEBUG_LIGHTING !== '0'

it.runIf(!!OUT)(
  'debug dump',
  () => {
    const world = makeWorld(1800, 1200, 3)
    const path = sweepPath(world.width, world.height, 640, 360, 12)
    const s = new Stitcher({ ...DEFAULT_SETTINGS, crop: { top: 0, bottom: 0, left: 0, right: 0 } })
    for (let i = 0; i < path.length; i++) {
      const gain = LIGHTING ? 1 + 0.2 * Math.sin(i / 25) : 1
      const shadow = LIGHTING ? 0.25 * (0.5 + 0.5 * Math.sin(i / 40)) : 0
      const rgba = renderFrame(world, path[i].x, path[i].y, 640, 360, gain, shadow, 7, ENDFIELD_VIGNETTE)
      if (i === 100) writePng(`${OUT}/frame.png`, rgba, 640, 360)
      const st = s.process({ rgba, width: 640, height: 360, timestamp: i * 33 })
      if (i % 40 === 0) console.log(i, st.state, st.drawMode, 'lighting', gain.toFixed(3))
    }
    writeMosaicPng(`${OUT}/mosaic.png`, s.mosaic)
    // Ratio map mosaic/truth (gray 128 = 1.0), reveals seams & misplaced content.
    {
      const offX = path[0].x
      const offY = path[0].y
      const b = s.mosaic.exactBounds()!
      const w = b.maxX - b.minX
      const h = b.maxY - b.minY
      const img = new Uint8ClampedArray(w * h * 4)
      const shown = new Uint32Array(TILE_SIZE * TILE_SIZE)
      let shownTile: unknown = null
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const wx = b.minX + x
          const wy = b.minY + y
          const t = s.mosaic.getTile(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE))
          const o = (y * w + x) * 4
          img[o + 3] = 255
          if (!t) continue
          if (t !== shownTile) {
            shownTile = t
            s.mosaic.renderTile(t, shown)
          }
          const li = (wy - t.ty * TILE_SIZE) * TILE_SIZE + (wx - t.tx * TILE_SIZE)
          const gx = wx + offX
          const gy = wy + offY
          if (!t.q[li] || gx >= world.width || gy >= world.height) continue
          const wi = (gy * world.width + gx) * 3
          const truth = (world.rgb[wi] * 77 + world.rgb[wi + 1] * 150 + world.rgb[wi + 2] * 29) >> 8
          const p = shown[li]
          const r = (((p & 0xff) * 77 + ((p >>> 8) & 0xff) * 150 + ((p >>> 16) & 0xff) * 29) >> 8) / Math.max(1, truth)
          img[o] = img[o + 1] = img[o + 2] = 128 + (r - 1) * 300
          if (r > 1.3 || r < 0.7) img[o] = 255
        }
      }
      writePng(`${OUT}/ratio.png`, img, w, h)
    }
    const q = s.getQualityMap()!
    const qi = new Uint8ClampedArray(q.width * q.height * 4)
    for (let i = 0; i < q.q.length; i++) {
      qi[i * 4] = qi[i * 4 + 1] = qi[i * 4 + 2] = q.q[i]
      qi[i * 4 + 3] = 255
    }
    writePng(`${OUT}/quality.png`, qi, q.width, q.height)
  },
  600000,
)
