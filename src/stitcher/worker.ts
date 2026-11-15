/**
 * Stitching worker. Owns the Stitcher and the full-resolution map; the UI thread only
 * receives small preview tiles, status updates and the final PNG.
 *
 * Frames arrive as VideoFrames, ideally pulled from a MediaStreamTrackProcessor stream
 * so that capture keeps running while the page is in the background (the game has
 * focus, and Chrome throttles timers / rAF on hidden pages but not worker streams).
 */
import { TILE_SIZE, type Tile } from './mosaic'
import type { TilePreview, WorkerRequest, WorkerResponse, WorldRect } from './protocol'
import { DEFAULT_SETTINGS, Stitcher } from './stitcher'

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const scope = self as unknown as WorkerScope
const post = (message: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

const PREVIEW_SCALE = 4
const PREVIEW_SIZE = TILE_SIZE / PREVIEW_SCALE
const PREVIEW_INTERVAL_MS = 200
const MASK_INTERVAL_MS = 500

const stitcher = new Stitcher(DEFAULT_SETTINGS)
let maxWidth = 1920
let lockedSize: { w: number; h: number } | null = null

let frameCanvas: OffscreenCanvas | null = null
let frameCtx: OffscreenCanvasRenderingContext2D | null = null
const tileCanvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
const tileCtx = tileCanvas.getContext('2d')!
const previewCanvas = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE)
const previewCtx = previewCanvas.getContext('2d')!
previewCtx.imageSmoothingQuality = 'high'

let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let lastPreview = 0
let lastMaskPost = 0
let postedMaskVersion = -1
const frameTimes: number[] = []

function processFrame(frame: VideoFrame): void {
  let w: number
  let h: number
  let timestamp: number
  try {
    const scale = Math.min(1, maxWidth / frame.displayWidth)
    w = Math.max(16, Math.round(frame.displayWidth * scale))
    h = Math.max(16, Math.round(frame.displayHeight * scale))
    // The map has a fixed scale: once it has content, keep feeding frames at the size
    // it was built with (a resolution change only applies after "Clear map").
    if (lockedSize && !stitcher.mosaic.isEmpty) {
      const sameAspect = Math.abs(lockedSize.w / lockedSize.h - w / h) < 0.01
      if (sameAspect) {
        w = lockedSize.w
        h = lockedSize.h
      }
    }
    timestamp = frame.timestamp / 1000
    if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) {
      frameCanvas = new OffscreenCanvas(w, h)
      frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true, alpha: false })!
    }
    frameCtx!.drawImage(frame, 0, 0, w, h)
  } finally {
    frame.close()
  }
  const image = frameCtx!.getImageData(0, 0, w, h)
  const status = stitcher.process({ rgba: image.data, width: w, height: h, timestamp })
  lockedSize = stitcher.mosaic.isEmpty ? null : { w, h }

  const now = performance.now()
  frameTimes.push(now)
  while (frameTimes.length > 0 && now - frameTimes[0] > 1000) frameTimes.shift()
  post({ type: 'status', status, fps: frameTimes.length })

  if (now - lastPreview > PREVIEW_INTERVAL_MS) {
    lastPreview = now
    postTiles(stitcher.mosaic.takeDirty())
  }
  if (status.maskVersion !== postedMaskVersion && now - lastMaskPost > MASK_INTERVAL_MS) {
    lastMaskPost = now
    postedMaskVersion = status.maskVersion
    postMask()
  }
}

function renderPreview(tile: Tile): ImageBitmap {
  tileCtx.putImageData(new ImageData(tile.rgba, TILE_SIZE, TILE_SIZE), 0, 0)
  previewCtx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
  previewCtx.drawImage(tileCanvas, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
  return previewCanvas.transferToImageBitmap()
}

function postTiles(tiles: Tile[], cleared = false): void {
  if (tiles.length === 0 && !cleared) return
  const previews: TilePreview[] = tiles.map((t) => ({ tx: t.tx, ty: t.ty, bitmap: renderPreview(t) }))
  post(
    { type: 'tiles', tiles: previews, tileSize: TILE_SIZE, previewScale: PREVIEW_SCALE, cleared },
    previews.map((p) => p.bitmap),
  )
}

function postMask(): void {
  const m = stitcher.getUiMask()
  if (!m) return
  const rgba = new Uint8ClampedArray(m.width * m.height * 4)
  for (let i = 0; i < m.mask.length; i++) {
    if (!m.mask[i]) continue
    rgba[i * 4] = 255
    rgba[i * 4 + 1] = 40
    rgba[i * 4 + 2] = 60
    rgba[i * 4 + 3] = 150
  }
  const canvas = new OffscreenCanvas(m.width, m.height)
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, m.width, m.height), 0, 0)
  const bitmap = canvas.transferToImageBitmap()
  post({ type: 'mask', bitmap }, [bitmap])
}

async function pump(stream: ReadableStream<VideoFrame>): Promise<void> {
  const previous = reader
  const own = stream.getReader()
  reader = own
  previous?.cancel().catch(() => {})
  try {
    for (;;) {
      const { value, done } = await own.read()
      if (done || reader !== own) {
        value?.close()
        break
      }
      try {
        processFrame(value)
      } catch (err) {
        post({ type: 'error', message: String(err) })
      }
    }
  } catch (err) {
    post({ type: 'error', message: `Capture stream failed: ${String(err)}` })
  } finally {
    if (reader === own) {
      reader = null
      postTiles(stitcher.mosaic.takeDirty())
      post({ type: 'stream-ended' })
    }
  }
}

/**
 * Full-resolution tile bitmaps for the zoomed-in viewer. Built straight from the
 * pixels: transferToImageBitmap() on the shared tile canvas right after
 * putImageData() comes back blank in Chrome.
 */
async function postFullTiles(keys: Array<[number, number]>): Promise<void> {
  const out: TilePreview[] = []
  for (const [tx, ty] of keys) {
    const t = stitcher.mosaic.getTile(tx, ty)
    if (!t) continue
    out.push({ tx, ty, bitmap: await createImageBitmap(new ImageData(t.rgba, TILE_SIZE, TILE_SIZE)) })
  }
  post({ type: 'full-tiles', tiles: out }, out.map((t) => t.bitmap))
}

function fillMapGaps(maxGap: number): void {
  if (maxGap <= 0) return
  stitcher.mosaic.fillGaps(maxGap)
  postTiles(stitcher.mosaic.takeDirty())
}

/** Draws the map's tiles covering world rectangle `r` into a new canvas at `scale`. */
function renderRegion(r: WorldRect, scale: number): OffscreenCanvas {
  const ow = Math.max(1, Math.round(r.w * scale))
  const oh = Math.max(1, Math.round(r.h * scale))
  const out = new OffscreenCanvas(ow, oh)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  for (const t of stitcher.mosaic.tiles.values()) {
    const dx = t.tx * TILE_SIZE - r.x
    const dy = t.ty * TILE_SIZE - r.y
    if (dx >= r.w || dy >= r.h || dx + TILE_SIZE <= 0 || dy + TILE_SIZE <= 0) continue
    const data = new ImageData(t.rgba, TILE_SIZE, TILE_SIZE)
    if (scale === 1) {
      ctx.putImageData(data, dx, dy)
    } else {
      tileCtx.putImageData(data, 0, 0)
      ctx.drawImage(tileCanvas, dx * scale, dy * scale, TILE_SIZE * scale, TILE_SIZE * scale)
    }
  }
  return out
}

function mapRect(): WorldRect | null {
  const b = stitcher.mosaic.exactBounds()
  return b ? { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY } : null
}

function exportPreview(id: number, maxSide: number, fillGaps: number): void {
  fillMapGaps(fillGaps)
  const r = mapRect()
  if (!r) {
    post({ type: 'export-failed', id, message: 'The map is empty.' })
    return
  }
  const bitmap = renderRegion(r, Math.min(1, maxSide / Math.max(r.w, r.h))).transferToImageBitmap()
  post({ type: 'export-preview', id, bitmap, bounds: r }, [bitmap])
}

async function exportPng(id: number, maxPixels: number, fillGaps: number, crop?: WorldRect): Promise<void> {
  fillMapGaps(fillGaps)
  const r = crop ?? mapRect()
  if (!r || r.w < 1 || r.h < 1) {
    post({ type: 'export-failed', id, message: 'The map is empty.' })
    return
  }
  // Browsers cap canvas size (Chrome: 16384 px per side and ~268 MP in total).
  const scale = Math.min(1, 16384 / r.w, 16384 / r.h, Math.sqrt(maxPixels / (r.w * r.h)))
  const out = renderRegion(r, scale)
  const blob = await out.convertToBlob({ type: 'image/png' })
  post({ type: 'exported', id, blob, width: out.width, height: out.height, scale })
}

scope.onmessage = (event) => {
  const msg = event.data
  switch (msg.type) {
    case 'start-stream':
      void pump(msg.stream)
      break
    case 'frame':
      try {
        processFrame(msg.frame)
      } catch (err) {
        post({ type: 'error', message: String(err) })
      }
      post({ type: 'frame-done' })
      break
    case 'stop': {
      // Detach first so the pump doesn't report 'stream-ended' for a user-initiated stop
      // (that notice could otherwise arrive after a new capture has already started).
      const r = reader
      reader = null
      r?.cancel().catch(() => {})
      postTiles(stitcher.mosaic.takeDirty())
      break
    }
    case 'settings':
      stitcher.updateSettings(msg.settings)
      maxWidth = msg.maxWidth
      break
    case 'clear-map':
      stitcher.clearMap()
      postTiles([], true)
      break
    case 'reset-ui-mask':
      stitcher.resetUiMask()
      break
    case 'request-full-tiles':
      void postFullTiles(msg.keys)
      break
    case 'resend-tiles':
      postTiles([...stitcher.mosaic.tiles.values()], true)
      break
    case 'export-preview':
      try {
        exportPreview(msg.id, msg.maxSide, msg.fillGaps)
      } catch (err) {
        post({ type: 'export-failed', id: msg.id, message: String(err) })
      }
      break
    case 'export':
      exportPng(msg.id, msg.maxPixels, msg.fillGaps, msg.crop).catch((err) =>
        post({ type: 'export-failed', id: msg.id, message: String(err) }),
      )
      break
  }
}
