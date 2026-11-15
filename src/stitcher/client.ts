import type { TilePreview, WorkerRequest, WorkerResponse, WorldRect } from './protocol'
import type { FrameStatus, StitchSettings } from './stitcher'

export interface ClientEvents {
  status?: (status: FrameStatus, fps: number) => void
  tiles?: (tiles: TilePreview[], tileSize: number, previewScale: number, cleared: boolean) => void
  fullTiles?: (tiles: TilePreview[]) => void
  mask?: (bitmap: ImageBitmap) => void
  streamEnded?: () => void
  error?: (message: string) => void
}

/** Typed wrapper around the stitching worker. */
export class StitcherClient {
  private worker: Worker
  private events: ClientEvents = {}
  private nextRequestId = 1
  /** Export and export-preview requests awaiting the worker's answer. */
  private pending = new Map<number, { resolve: (r: never) => void; reject: (e: Error) => void }>()
  private frameWaiter: (() => void) | null = null

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data)
    this.worker.onerror = (e) => this.events.error?.(e.message || 'Worker crashed')
  }

  on(events: ClientEvents): void {
    this.events = events
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer)
  }

  private handle(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'status':
        this.events.status?.(msg.status, msg.fps)
        break
      case 'tiles':
        this.events.tiles?.(msg.tiles, msg.tileSize, msg.previewScale, !!msg.cleared)
        break
      case 'full-tiles':
        this.events.fullTiles?.(msg.tiles)
        break
      case 'mask':
        this.events.mask?.(msg.bitmap)
        break
      case 'frame-done':
        this.frameWaiter?.()
        this.frameWaiter = null
        break
      case 'stream-ended':
        this.events.streamEnded?.()
        break
      case 'exported':
        this.settle<ExportResult>(msg.id, { blob: msg.blob, width: msg.width, height: msg.height, scale: msg.scale })
        break
      case 'export-preview':
        this.settle<ExportPreview>(msg.id, { bitmap: msg.bitmap, bounds: msg.bounds })
        break
      case 'export-failed': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.reject(new Error(msg.message))
        break
      }
      case 'error':
        this.events.error?.(msg.message)
        break
    }
  }

  startStream(stream: ReadableStream<VideoFrame>): void {
    this.send({ type: 'start-stream', stream }, [stream as unknown as Transferable])
  }

  /** Push one frame (fallback path); resolves when the worker is ready for the next. */
  pushFrame(frame: VideoFrame): Promise<void> {
    return new Promise((resolve) => {
      this.frameWaiter = resolve
      this.send({ type: 'frame', frame }, [frame])
    })
  }

  stop(): void {
    this.send({ type: 'stop' })
  }

  updateSettings(settings: StitchSettings, maxWidth: number): void {
    this.send({ type: 'settings', settings, maxWidth })
  }

  clearMap(): void {
    this.send({ type: 'clear-map' })
  }

  resetUiMask(): void {
    this.send({ type: 'reset-ui-mask' })
  }

  requestFullTiles(keys: Array<[number, number]>): void {
    this.send({ type: 'request-full-tiles', keys })
  }

  resendTiles(): void {
    this.send({ type: 'resend-tiles' })
  }

  private settle<T>(id: number, value: T): void {
    const p = this.pending.get(id)
    this.pending.delete(id)
    ;(p?.resolve as ((v: T) => void) | undefined)?.(value)
  }

  private request<T>(build: (id: number) => WorkerRequest): Promise<T> {
    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: never) => void, reject })
      this.send(build(id))
    })
  }

  /** Downscaled snapshot of the whole map for the crop dialog. Fills gaps first, like an export. */
  exportPreview(maxSide = 2048, fillGaps = 16): Promise<ExportPreview> {
    return this.request((id) => ({ type: 'export-preview', id, maxSide, fillGaps }))
  }

  /** `crop` is in world coordinates; omit it to export the whole map. */
  exportPng(crop?: WorldRect, maxPixels = 200_000_000, fillGaps = 16): Promise<ExportResult> {
    return this.request((id) => ({ type: 'export', id, maxPixels, fillGaps, crop }))
  }

  dispose(): void {
    this.worker.terminate()
  }
}

export interface ExportPreview {
  bitmap: ImageBitmap
  /** World rectangle the bitmap covers. */
  bounds: WorldRect
}

export interface ExportResult {
  blob: Blob
  width: number
  height: number
  scale: number
}
