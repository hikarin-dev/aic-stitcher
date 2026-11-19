/**
 * Stitching worker. Owns the Stitcher and the full-resolution map; the UI thread only
 * receives small preview tiles, status updates and the final PNG.
 *
 * Frames arrive as VideoFrames, ideally pulled from a MediaStreamTrackProcessor stream
 * so that capture keeps running while the page is in the background (the game has
 * focus, and Chrome throttles timers / rAF on hidden pages but not worker streams).
 */
import { CONF_SIZE, TILE_SIZE, type Tile } from './mosaic'
import type { TilePreview, WorkerRequest, WorkerResponse, WorldRect } from './protocol'
import { DEFAULT_KEYFRAME_BYTES } from './stills'
import { DEFAULT_SETTINGS, Stitcher, type FrameStatus, type StillImage } from './stitcher'

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
const STATUS_INTERVAL_MS = 100

const stitcher = new Stitcher(DEFAULT_SETTINGS)
/**
 * Memory for the still frames of a screen share. Unlike those of a recording they can't
 * be read again, and every stop that is dropped leaves its neighbours further apart,
 * which shows where they are joined. Sharing only exists on desktops, so this can be
 * generous: 1 GB holds about 70 stops at 1440p. (`deviceMemory` is Chrome's; it tops
 * out at 8.)
 */
const LIVE_KEYFRAME_BYTES = (() => {
  const gb = (navigator as { deviceMemory?: number }).deviceMemory ?? 8
  return (gb >= 8 ? 1024 : gb >= 4 ? 640 : 320) * 1024 * 1024
})()
/** Frames wider than this are downscaled first. The UI sends the real value right away; native until then. */
let maxWidth = Infinity
let lockedSize: { w: number; h: number } | null = null

let frameCanvas: OffscreenCanvas | null = null
let frameCtx: OffscreenCanvasRenderingContext2D | null = null
const tileCanvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
const tileCtx = tileCanvas.getContext('2d')!
const previewCanvas = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE)
const previewCtx = previewCanvas.getContext('2d')!
/** The preview is rendered at its own size (see Mosaic.renderTilePreview) into here... */
const previewPixels = new Uint8ClampedArray(PREVIEW_SIZE * PREVIEW_SIZE * 4)
const previewPixels32 = new Uint32Array(previewPixels.buffer)
/** ...and goes through a second canvas: a bitmap taken from one right after putImageData() comes out blank in Chrome. */
const previewStage = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE)
const previewStageCtx = previewStage.getContext('2d')!
const PREVIEW_SHIFT = Math.log2(PREVIEW_SCALE)

/** Scratch buffer the map's tiles are rendered into (detail re-lit with the lighting layer). */
const tilePixels = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
const tilePixels32 = new Uint32Array(tilePixels.buffer)

let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let lastPreview = 0
/** How long the last preview update took (ms). */
let previewCost = 0
let lastStatusPost = 0
let lastStatusState: FrameStatus['state'] | null = null
/** The newest status that the throttle held back; it goes out when the stream ends or capture stops. */
let pendingStatus: { status: FrameStatus; fps: number } | null = null
let lastMaskPost = 0
let postedMaskVersion = -1
const frameTimes: number[] = []

/** Sends the status the throttle held back, if any, so the UI doesn't keep showing old numbers. */
function flushStatus(): void {
  if (!pendingStatus) return
  const { status, fps } = pendingStatus
  pendingStatus = null
  lastStatusState = status.state
  lastStatusPost = performance.now()
  post({ type: 'status', status, fps })
}

/** The size a source of `width`×`height` is processed at. */
function processingSize(width: number, height: number): { w: number; h: number } {
  const scale = Math.min(1, maxWidth / width)
  let w = Math.max(16, Math.round(width * scale))
  let h = Math.max(16, Math.round(height * scale))
  // The map has a fixed scale: once it has content, keep feeding frames at the size
  // it was built with (a resolution change only applies after "Clear map").
  if (lockedSize && !stitcher.mosaic.isEmpty) {
    const sameAspect = Math.abs(lockedSize.w / lockedSize.h - w / h) < 0.01
    if (sameAspect) {
      w = lockedSize.w
      h = lockedSize.h
    }
  }
  return { w, h }
}

/** A frame's pixels (RGBA) at the size the map is built at. */
interface FramePixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Whether VideoFrame.copyTo() converts to RGBA. Where it doesn't, the `format` option
 * is silently ignored and the frame's own format comes back, so this is found out
 * with a frame whose format is known: 2×2 pixels of I420 are 6 bytes, of RGBA 16.
 */
let copiesRgba = ((): boolean => {
  try {
    const probe = new VideoFrame(new Uint8Array(6), { format: 'I420', codedWidth: 2, codedHeight: 2, timestamp: 0 })
    const ok = probe.allocationSize({ format: 'RGBA' } as VideoFrameCopyToOptions) === 16
    probe.close()
    return ok
  } catch {
    return false
  }
})()
/**
 * Where copied frames go. Two buffers, used in turn: the next frame is read while the
 * current one is stitched (the stitcher copies what it keeps).
 */
const frameBuffers: Array<Uint8ClampedArray | null> = [null, null]
let frameTurn = 0

/**
 * The frame's pixels at the size the map is built at. Closes the frame.
 *
 * At its own size a frame is copied straight out of the VideoFrame (the pixels are the
 * same as a canvas gives, to the last bit). Going through a canvas (draw the frame,
 * read the canvas back) is the only way to scale it, and somewhat slower.
 */
async function framePixels(frame: VideoFrame): Promise<FramePixels> {
  try {
    const { w, h } = processingSize(frame.displayWidth, frame.displayHeight)
    const rect = frame.visibleRect
    if (copiesRgba && rect && rect.width === w && rect.height === h && frame.displayWidth === w && frame.displayHeight === h) {
      const size = w * h * 4
      const turn = (frameTurn = 1 - frameTurn)
      let data = frameBuffers[turn]
      if (!data || data.length !== size) data = frameBuffers[turn] = new Uint8ClampedArray(size)
      try {
        await frame.copyTo(data, { format: 'RGBA' } as VideoFrameCopyToOptions)
        return { data, width: w, height: h }
      } catch {
        // Not for this kind of frame, then: the canvas does it.
        copiesRgba = false
      }
    }
    if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) {
      frameCanvas = new OffscreenCanvas(w, h)
      frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true, alpha: false })!
    }
    frameCtx!.drawImage(frame, 0, 0, w, h)
    return frameCtx!.getImageData(0, 0, w, h)
  } finally {
    frame.close()
  }
}

/**
 * Counts up whenever something other than the next frame takes over the map (a stop, a
 * rebuild, clearing it...). A frame whose pixels were still being read at that moment
 * is no longer wanted.
 */
let session = 0

/** A frame that has been read and waits to be stitched. */
interface ReadFrame {
  image: FramePixels
  /** Milliseconds. */
  timestamp: number
  /** `session` when the read began. */
  session: number
}

/**
 * Reading a frame's pixels mostly means waiting for the browser, and stitching can go
 * on meanwhile: the two are separate steps so the next frame can be read while the
 * current one is stitched.
 */
async function readFrame(frame: VideoFrame): Promise<ReadFrame> {
  const mine = session
  const timestamp = frame.timestamp / 1000
  return { image: await framePixels(frame), timestamp, session: mine }
}

function stitchFrame(read: ReadFrame, refetchKey?: number): void {
  if (read.session !== session) return
  stitcher.setKeyframeBudget(refetchKey === undefined ? LIVE_KEYFRAME_BYTES : DEFAULT_KEYFRAME_BYTES)
  const { image, timestamp } = read
  const w = image.width
  const h = image.height
  const status = stitcher.process({ rgba: image.data, width: w, height: h, timestamp, refetchKey })
  lockedSize = stitcher.mosaic.isEmpty ? null : { w, h }

  const now = performance.now()
  frameTimes.push(now)
  while (frameTimes.length > 0 && now - frameTimes[0] > 1000) frameTimes.shift()
  if (status.state !== lastStatusState || now - lastStatusPost >= STATUS_INTERVAL_MS) {
    lastStatusState = status.state
    lastStatusPost = now
    pendingStatus = null
    post({ type: 'status', status, fps: frameTimes.length })
  } else {
    pendingStatus = { status, fps: frameTimes.length }
  }

  // (Never more than about a fifth of the time goes into showing the map.)
  if (now - lastPreview > Math.max(PREVIEW_INTERVAL_MS, 4 * previewCost)) {
    postTiles(stitcher.mosaic.takeDirty())
    lastPreview = performance.now()
    previewCost = lastPreview - now
  }
  if (status.maskVersion !== postedMaskVersion && now - lastMaskPost > MASK_INTERVAL_MS) {
    lastMaskPost = now
    postedMaskVersion = status.maskVersion
    postMask()
  }
}

/** Everything the UI shows about the map, after an operation that was not a frame. */
function postMapState(): void {
  postTiles(stitcher.mosaic.takeDirty())
  // The status sent here is fresh, so a held-back one is out of date.
  pendingStatus = null
  const status = stitcher.idleStatus()
  if (status) post({ type: 'status', status, fps: 0 })
}

function stitchImages(id: number, bitmaps: ImageBitmap[]): void {
  const images: StillImage[] = []
  for (const bitmap of bitmaps) {
    const { w, h } = processingSize(bitmap.width, bitmap.height)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    // Each image keeps its own buffer: the stitcher holds on to it as a still frame.
    images.push({ rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h })
    // The first image decides the size for the rest of a new map.
    if (!lockedSize && stitcher.mosaic.isEmpty) lockedSize = { w, h }
  }
  const result = stitcher.stitchImages(images)
  if (stitcher.mosaic.isEmpty) lockedSize = null
  postMapState()
  post({ type: 'images-done', id, result })
}

/** A rebuild under way. It stays so across messages while it waits for a frame (see `need-frame`). */
interface RebuildRun {
  id: number
  /** Hands over the frame it is waiting for. */
  frameArrived: ((frame: VideoFrame | null) => void) | null
  ended: boolean
}
let rebuildRun: RebuildRun | null = null

/** Finishes a rebuild with the patches laid in so far, and reports it. */
function endRebuild(run: RebuildRun, failure?: unknown): void {
  if (run.ended) return
  run.ended = true
  if (rebuildRun === run) rebuildRun = null
  const result = stitcher.rebuildEnd()
  postMapState()
  if (failure === undefined) post({ type: 'rebuilt', id: run.id, result })
  else post({ type: 'export-failed', id: run.id, message: String(failure) })
  // If it was waiting for a frame, it need not any longer.
  const arrived = run.frameArrived
  run.frameArrived = null
  arrived?.(null)
}

/**
 * Rebuilds the map from its still frames. Stills whose pixels were dropped to save
 * memory are read from the recording again, one at a time, if the UI can do that.
 */
async function rebuild(id: number, canFetch: boolean): Promise<void> {
  const plan = stitcher.rebuildBegin(canFetch)
  if (!plan) {
    postMapState()
    post({ type: 'rebuilt', id, result: null })
    return
  }
  const run: RebuildRun = { id, frameArrived: null, ended: false }
  rebuildRun = run
  try {
    for (let i = 0; i < plan.patches.length; i++) {
      const patch = plan.patches[i]
      if (patch.inMemory) {
        stitcher.rebuildPatch(i)
      } else if (patch.key !== null) {
        const key = patch.key
        const frame = await new Promise<VideoFrame | null>((resolve) => {
          run.frameArrived = resolve
          post({ type: 'need-frame', id, key })
        })
        // Something else needed the map in the meantime: the rebuild was ended there.
        if (run.ended) {
          frame?.close()
          return
        }
        if (frame) {
          const image = await framePixels(frame)
          // (The rebuild may have been ended while the pixels were being read.)
          if (run.ended) return
          stitcher.rebuildPatch(i, { rgba: image.data, width: image.width, height: image.height })
        }
      }
      post({ type: 'rebuild-progress', id, done: i + 1, total: plan.patches.length })
      // Show the map as it comes together.
      postTiles(stitcher.mosaic.takeDirty())
    }
    endRebuild(run)
  } catch (err) {
    endRebuild(run, err)
  }
}

function renderPreview(tile: Tile): ImageBitmap {
  stitcher.mosaic.renderTilePreview(tile, previewPixels32, PREVIEW_SHIFT)
  previewStageCtx.putImageData(new ImageData(previewPixels, PREVIEW_SIZE, PREVIEW_SIZE), 0, 0)
  previewCtx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
  previewCtx.drawImage(previewStage, 0, 0)
  return previewCanvas.transferToImageBitmap()
}

function postTiles(tiles: Tile[], cleared = false): void {
  if (tiles.length === 0 && !cleared) return
  const previews: TilePreview[] = tiles.map((t) => {
    const confidence = new Uint8Array(CONF_SIZE * CONF_SIZE)
    stitcher.mosaic.confidence(t, confidence)
    return { tx: t.tx, ty: t.ty, bitmap: renderPreview(t), confidence }
  })
  post(
    { type: 'tiles', tiles: previews, tileSize: TILE_SIZE, previewScale: PREVIEW_SCALE, cleared },
    previews.flatMap((p) => (p.confidence ? [p.bitmap, p.confidence.buffer] : [p.bitmap])),
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
    // One frame ahead: while a frame is stitched, the pixels of the next are being read.
    let ahead: Promise<ReadFrame> | null = null
    for (;;) {
      const { value, done } = await own.read()
      if (done || reader !== own) {
        value?.close()
        break
      }
      const reading = readFrame(value)
      // (Handled where it is awaited; this only keeps a failed read from going unheard.)
      reading.catch(() => {})
      const current = ahead
      ahead = reading
      if (!current) continue
      try {
        stitchFrame(await current)
      } catch (err) {
        post({ type: 'error', message: String(err) })
      }
    }
  } catch (err) {
    post({ type: 'error', message: `Capture stream failed: ${String(err)}` })
  } finally {
    if (reader === own) {
      reader = null
      flushStatus()
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
    // A fresh buffer per tile: the bitmap is decoded asynchronously.
    const pixels = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
    stitcher.mosaic.renderTile(t, new Uint32Array(pixels.buffer))
    out.push({ tx, ty, bitmap: await createImageBitmap(new ImageData(pixels, TILE_SIZE, TILE_SIZE)) })
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
    stitcher.mosaic.renderTile(t, tilePixels32)
    const data = new ImageData(tilePixels, TILE_SIZE, TILE_SIZE)
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

/**
 * Requests that work on the map. A rebuild that is waiting for a frame has the map
 * half put together, so it is ended before any of these.
 */
const ENDS_REBUILD: ReadonlySet<WorkerRequest['type']> = new Set([
  'start-stream',
  'frame',
  'stop',
  'images',
  'rebuild',
  'clear-map',
  'export-preview',
  'export',
])

scope.onmessage = (event) => {
  const msg = event.data
  if (rebuildRun && ENDS_REBUILD.has(msg.type)) endRebuild(rebuildRun)
  // (Anything that takes over the map, that is, except the next frame.)
  if (msg.type !== 'frame' && ENDS_REBUILD.has(msg.type)) session++
  switch (msg.type) {
    case 'start-stream':
      void pump(msg.stream)
      break
    case 'frame':
      // "Done" as soon as the pixels are in: whoever pushes frames can fetch the next
      // one (seeking a video takes a while) while this one is stitched. The stitching
      // follows without a break, so nothing else gets in between.
      readFrame(msg.frame).then(
        (read) => {
          post({ type: 'frame-done' })
          try {
            stitchFrame(read, msg.refetchKey)
          } catch (err) {
            post({ type: 'error', message: String(err) })
          }
        },
        (err) => {
          post({ type: 'error', message: String(err) })
          post({ type: 'frame-done' })
        },
      )
      break
    case 'stop': {
      // Detach first so the pump doesn't report 'stream-ended' for a user-initiated stop
      // (that notice could otherwise arrive after a new capture has already started).
      const r = reader
      reader = null
      r?.cancel().catch(() => {})
      // A recording that was being read is closed now: its frames can't be had again.
      stitcher.forgetSource()
      flushStatus()
      postTiles(stitcher.mosaic.takeDirty())
      break
    }
    case 'images':
      try {
        stitchImages(msg.id, msg.images)
      } catch (err) {
        post({ type: 'export-failed', id: msg.id, message: String(err) })
      }
      break
    case 'rebuild':
      void rebuild(msg.id, !!msg.canFetch)
      break
    case 'rebuild-frame': {
      const run = rebuildRun?.id === msg.id ? rebuildRun : null
      const arrived = run?.frameArrived
      if (run && arrived) {
        run.frameArrived = null
        arrived(msg.frame)
      } else {
        // Nobody is waiting for it (any more).
        msg.frame?.close()
      }
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
