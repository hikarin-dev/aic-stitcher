/** Messages exchanged between the UI thread and the stitching worker. */
import type { FrameStatus, StitchSettings } from './stitcher'

export type WorkerRequest =
  /** Frames are pulled from this stream inside the worker (Chrome's MediaStreamTrackProcessor). */
  | { type: 'start-stream'; stream: ReadableStream<VideoFrame> }
  /** Fallback push mode: one frame at a time; the worker answers with `frame-done`. */
  | { type: 'frame'; frame: VideoFrame }
  | { type: 'stop' }
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
}

export type WorkerResponse =
  | { type: 'status'; status: FrameStatus; fps: number }
  | { type: 'tiles'; tiles: TilePreview[]; tileSize: number; previewScale: number; cleared?: boolean }
  /** HUD mask overlay (mask scale, red = excluded) in capture-frame proportions. */
  | { type: 'mask'; bitmap: ImageBitmap }
  | { type: 'full-tiles'; tiles: TilePreview[] }
  | { type: 'frame-done' }
  | { type: 'stream-ended' }
  | { type: 'exported'; id: number; blob: Blob; width: number; height: number; scale: number }
  /** `bounds`: world rectangle the bitmap covers (the map's exact bounds). */
  | { type: 'export-preview'; id: number; bitmap: ImageBitmap; bounds: WorldRect }
  | { type: 'export-failed'; id: number; message: string }
  | { type: 'error'; message: string }
