/** Messages exchanged between the UI thread and the stitching worker. */
import type { FrameStatus, ImageStitchResult, RebuildResult, StitchSettings } from './stitcher'

export type WorkerRequest =
  /** Frames are pulled from this stream inside the worker (Chrome's MediaStreamTrackProcessor). */
  | { type: 'start-stream'; stream: ReadableStream<VideoFrame> }
  /** Fallback push mode: one frame at a time; the worker answers with `frame-done`. */
  | { type: 'frame'; frame: VideoFrame; refetchKey?: number }
  | { type: 'stop' }
  /** Still images (screenshots) to stitch into the map; answered with `images-done`. */
  | { type: 'images'; id: number; images: ImageBitmap[] }
  /** Rebuild the map from the still frames kept so far; answered with `rebuilt`. */
  /**
   * `canFetch`: frames pushed with a `refetchKey` can be asked for again. The worker
   * then sends `need-frame` for every still it has to read again and waits for a
   * `rebuild-frame` each time.
   */
  | { type: 'rebuild'; id: number; canFetch?: boolean }
  /** Answer to `need-frame`: the frame, or null if it can't be had (the still is left out). */
  | { type: 'rebuild-frame'; id: number; frame: VideoFrame | null }
  | { type: 'settings'; settings: StitchSettings; maxWidth: number }
  | { type: 'clear-map' }
  | { type: 'reset-ui-mask' }
  /** Ask for every tile preview again (e.g. after the viewer remounts). */
  | { type: 'resend-tiles' }
  /** Full-resolution bitmaps for these tiles (the viewer is zoomed in past preview scale). */
  | { type: 'request-full-tiles'; keys: Array<[number, number]> }
  /**
   * Downscaled picture of the whole map for the export crop dialog (longest side ≤ `maxSide`).
   * `fillGaps`: inpaint holes up to this many px wide first, so the preview matches the export.
   */
  | { type: 'export-preview'; id: number; maxSide: number; fillGaps: number }
  /**
   * `fillGaps`: inpaint holes up to this many px wide before exporting (0 = off).
   * `crop`: world-coordinate rectangle to export (default: the whole map).
   */
  | { type: 'export'; id: number; maxPixels: number; fillGaps: number; crop?: WorldRect }

export interface WorldRect {
  x: number
  y: number
  w: number
  h: number
}

export interface TilePreview {
  tx: number
  ty: number
  bitmap: ImageBitmap
  /**
   * Confidence grid of the tile (CONF_SIZE² cells, see Mosaic.confidence): 0 = empty,
   * otherwise the mean stored quality. Sent with previews only.
   */
  confidence?: Uint8Array
}

export type WorkerResponse =
  | { type: 'status'; status: FrameStatus; fps: number }
  | { type: 'tiles'; tiles: TilePreview[]; tileSize: number; previewScale: number; cleared?: boolean }
  /** HUD mask overlay (mask scale, red = excluded) in capture-frame proportions. */
  | { type: 'mask'; bitmap: ImageBitmap }
  | { type: 'full-tiles'; tiles: TilePreview[] }
  | { type: 'frame-done' }
  | { type: 'images-done'; id: number; result: ImageStitchResult }
  /** `result` is null when there were no still frames to rebuild from. */
  | { type: 'rebuilt'; id: number; result: RebuildResult | null }
  /** During a rebuild: the frame that was pushed with this `refetchKey` is needed again. */
  | { type: 'need-frame'; id: number; key: number }
  /** During a rebuild: `done` of `total` patches are in. */
  | { type: 'rebuild-progress'; id: number; done: number; total: number }
  | { type: 'stream-ended' }
  | { type: 'exported'; id: number; blob: Blob; width: number; height: number; scale: number }
  /** `bounds`: world rectangle the bitmap covers (the map's exact bounds). */
  | { type: 'export-preview'; id: number; bitmap: ImageBitmap; bounds: WorldRect }
  | { type: 'export-failed'; id: number; message: string }
  | { type: 'error'; message: string }
