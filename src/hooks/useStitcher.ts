import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createFrameStream,
  loadVideoFile,
  requestWindowCapture,
  seek,
  stepThroughVideo,
  supportsTrackProcessor,
  syntheticStream,
} from '@/stitcher/capture'
import { StitcherClient, type ExportPreview, type ExportResult } from '@/stitcher/client'
import { CONF_SIZE, SHARP_Q, WEAK_Q } from '@/stitcher/mosaic'
import type { WorldRect } from '@/stitcher/protocol'
import {
  DEFAULT_SETTINGS,
  type FrameStatus,
  type ImageStitchResult,
  type RebuildResult,
  type StitchSettings,
} from '@/stitcher/stitcher'

export interface TileEntry {
  tx: number
  ty: number
  bitmap: ImageBitmap
  /** Confidence overlay (one pixel per confidence cell): red = weak, amber = not yet sharp. */
  overlay?: OffscreenCanvas
}

/** Paints a tile's confidence grid: transparent where the map is sharp. */
function confidenceOverlay(confidence: Uint8Array): OffscreenCanvas {
  const canvas = new OffscreenCanvas(CONF_SIZE, CONF_SIZE)
  const image = new ImageData(CONF_SIZE, CONF_SIZE)
  for (let i = 0; i < confidence.length; i++) {
    const v = confidence[i]
    if (v === 0 || v >= SHARP_Q) continue
    const weak = v < WEAK_Q
    image.data[i * 4] = weak ? 239 : 245
    image.data[i * 4 + 1] = weak ? 68 : 158
    image.data[i * 4 + 2] = weak ? 68 : 11
    image.data[i * 4 + 3] = weak ? 150 : 95
  }
  canvas.getContext('2d')!.putImageData(image, 0, 0)
  return canvas
}

export interface TileStore {
  /** Downscaled previews of every tile (always complete). */
  tiles: Map<string, TileEntry>
  /** Full-resolution bitmaps, fetched on demand for the visible area when zoomed in. */
  full: Map<string, TileEntry>
  /** Full-resolution requests in flight. */
  pending: Set<string>
  /** Full-resolution tiles that changed since fetched (still drawn until refreshed). */
  stale: Set<string>
  tileSize: number
  previewScale: number
}

/** Max full-resolution tiles kept on the UI side (~1 MB of GPU memory each). */
const MAX_FULL_TILES = 200

export type CaptureState = 'idle' | 'starting' | 'capturing'

/** Work on the map that is not a capture: stitching screenshots, rebuilding from stills. */
export type BusyState = 'images' | 'rebuild' | null

export interface ImageBatchResult extends ImageStitchResult {
  /** File names of the images that could not be used, with the reason. */
  problems: Array<{ name: string; reason: string }>
}

/** Frames per second of video stitched from a file (what the replay tests are tuned on). */
const VIDEO_SAMPLE_FPS = 15

export interface Preferences {
  settings: StitchSettings
  /** Frames wider than this are downscaled before stitching (speed vs. detail). 0 = native. */
  maxWidth: number
  /** Rebuild the map from its still frames when a recording has been read to the end. */
  assembleFromStills: boolean
}

const STORAGE_KEY = 'aic-stitcher:preferences:v2'
/**
 * Preferences saved before the processing resolution defaulted to native. They are
 * carried over once, except for the resolution: v1 stored 1920 for everybody, chosen
 * or not, so it can't be told apart from a choice.
 */
const STORAGE_KEY_V1 = 'aic-stitcher:preferences:v1'
const DEFAULT_PREFERENCES: Preferences = { settings: DEFAULT_SETTINGS, maxWidth: 0, assembleFromStills: true }

function loadPreferences(): Preferences {
  try {
    let raw = localStorage.getItem(STORAGE_KEY)
    let carriedOver = false
    if (!raw) {
      raw = localStorage.getItem(STORAGE_KEY_V1)
      carriedOver = true
    }
    if (!raw) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<Preferences>
    if (carriedOver) delete parsed.maxWidth
    return {
      maxWidth: typeof parsed.maxWidth === 'number' ? parsed.maxWidth : DEFAULT_PREFERENCES.maxWidth,
      assembleFromStills:
        typeof parsed.assembleFromStills === 'boolean' ? parsed.assembleFromStills : DEFAULT_PREFERENCES.assembleFromStills,
      settings: {
        ...DEFAULT_SETTINGS,
        ...parsed.settings,
        crop: { ...DEFAULT_SETTINGS.crop, ...parsed.settings?.crop },
        paused: false,
      },
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function savePreferences(p: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Storage unavailable (private mode etc.) — preferences just won't persist.
  }
}

export function useStitcher() {
  const clientRef = useRef<StitcherClient | null>(null)
  const tileStore = useRef<TileStore>({
    tiles: new Map(),
    full: new Map(),
    pending: new Set(),
    stale: new Set(),
    tileSize: 512,
    previewScale: 4,
  })
  const [tilesVersion, setTilesVersion] = useState(0)
  const [tileCount, setTileCount] = useState(0)
  const [status, setStatus] = useState<FrameStatus | null>(null)
  const [fps, setFps] = useState(0)
  const [maskBitmap, setMaskBitmap] = useState<ImageBitmap | null>(null)
  const [captureState, setCaptureState] = useState<CaptureState>('idle')
  const [stream, setStream] = useState<MediaStream | null>(null)
  /** The video element of a file being processed (shown as the live preview). */
  const [fileVideo, setFileVideo] = useState<HTMLVideoElement | null>(null)
  /** 0..1 while a video file is processed, null otherwise. */
  const [videoProgress, setVideoProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences)
  const stopRef = useRef<(() => void) | null>(null)
  /** State of the most recently processed frame (status arrives before 'frame-done'). */
  const lastStateRef = useRef<FrameStatus['state'] | null>(null)
  /** Which pass over a video file is running (see startVideoFile). */
  const [videoPass, setVideoPass] = useState<'main' | 'start' | 'assemble'>('main')
  const [busy, setBusy] = useState<BusyState>(null)
  /** 0..1 while `busy` is 'rebuild'. */
  const [rebuildProgress, setRebuildProgress] = useState(0)

  // Worker lifetime.
  useEffect(() => {
    const client = new StitcherClient()
    clientRef.current = client
    const store = tileStore.current
    client.on({
      status: (s, f) => {
        lastStateRef.current = s.state
        setStatus(s)
        setFps(f)
      },
      tiles: (tiles, tileSize, previewScale, cleared) => {
        if (cleared) {
          for (const t of store.tiles.values()) t.bitmap.close()
          for (const t of store.full.values()) t.bitmap.close()
          store.tiles.clear()
          store.full.clear()
          store.pending.clear()
          store.stale.clear()
        }
        store.tileSize = tileSize
        store.previewScale = previewScale
        for (const t of tiles) {
          const k = `${t.tx},${t.ty}`
          store.tiles.get(k)?.bitmap.close()
          store.tiles.set(k, {
            tx: t.tx,
            ty: t.ty,
            bitmap: t.bitmap,
            overlay: t.confidence ? confidenceOverlay(t.confidence) : undefined,
          })
          // The full-resolution copy is now stale; the viewer re-requests it if visible.
          if (store.full.has(k)) store.stale.add(k)
        }
        setTilesVersion((v) => v + 1)
        setTileCount(store.tiles.size)
      },
      fullTiles: (tiles) => {
        for (const t of tiles) {
          const k = `${t.tx},${t.ty}`
          store.pending.delete(k)
          store.stale.delete(k)
          store.full.get(k)?.bitmap.close()
          store.full.delete(k)
          store.full.set(k, t)
        }
        // Evict the oldest entries (Map keeps insertion order).
        for (const [k, t] of store.full) {
          if (store.full.size <= MAX_FULL_TILES) break
          t.bitmap.close()
          store.full.delete(k)
          store.stale.delete(k)
        }
        setTilesVersion((v) => v + 1)
      },
      mask: (bitmap) =>
        setMaskBitmap((old) => {
          old?.close()
          return bitmap
        }),
      streamEnded: () => {
        const stop = stopRef.current
        stopRef.current = null
        stop?.()
      },
      error: (message) => setError(message),
    })
    client.resendTiles()
    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [])

  // Push settings to the worker and persist them.
  useEffect(() => {
    clientRef.current?.updateSettings(preferences.settings, preferences.maxWidth || 1e9)
    savePreferences(preferences)
  }, [preferences])

  const stopCapture = useCallback(() => {
    const stop = stopRef.current
    stopRef.current = null
    stop?.()
  }, [])

  /** Rebuilds the map from the still frames kept so far (see Stitcher.rebuildFromStills). */
  const rebuildFromStills = useCallback(async (): Promise<RebuildResult | null> => {
    const client = clientRef.current
    if (!client) return null
    setBusy('rebuild')
    setRebuildProgress(0)
    try {
      return await client.rebuild(undefined, setRebuildProgress)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(null)
    }
  }, [])
  /** Whether a screen share is running (not a recording being read). */
  const sharingRef = useRef(false)
  /** Whether a capture is assembled from its still frames when it ends. */
  const assembleRef = useRef(preferences.assembleFromStills)
  useEffect(() => {
    assembleRef.current = preferences.assembleFromStills
  }, [preferences.assembleFromStills])

  const begin = useCallback(async (getStream: (video: HTMLVideoElement) => Promise<MediaStream>) => {
    const client = clientRef.current
    if (!client) return
    stopRef.current?.()
    setError(null)
    setCaptureState('starting')
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    let media: MediaStream
    try {
      media = await getStream(video)
    } catch (err) {
      setCaptureState('idle')
      // The user closing the picker is not an error worth shouting about.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) setError(String(err))
      return
    }
    const track = media.getVideoTracks()[0]
    if (!track) {
      setCaptureState('idle')
      setError('The selected source has no video.')
      return
    }

    let active = true
    const frameStream = createFrameStream(track)
    if (frameStream) {
      client.startStream(frameStream)
    } else {
      // Fallback: push frames from a <video> element. Gets throttled when the tab is hidden.
      if (!video.srcObject && !video.src) video.srcObject = media
      await video.play().catch(() => {})
      void (async () => {
        while (active) {
          await new Promise<void>((resolve) => {
            if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => resolve())
            else setTimeout(resolve, 33)
          })
          if (!active || video.readyState < 2) continue
          await client.pushFrame(new VideoFrame(video))
        }
      })()
    }

    const onEnded = () => stopRef.current === stop && stopCapture()
    track.addEventListener('ended', onEnded)
    video.addEventListener('ended', onEnded)

    const stop = () => {
      active = false
      sharingRef.current = false
      client.stop()
      track.removeEventListener('ended', onEnded)
      for (const t of media.getTracks()) t.stop()
      video.pause()
      if (video.src) URL.revokeObjectURL(video.src)
      video.removeAttribute('src')
      video.srcObject = null
      setStream(null)
      setCaptureState('idle')
      // Like a recording when it ends: while sharing, the map is put together from
      // whatever frame was best for each spot at the time. Now that the sharing is
      // over, assemble it from the frames where the camera stood still.
      if (assembleRef.current) void rebuildFromStills()
    }
    stopRef.current = stop
    sharingRef.current = true
    setStream(media)
    setCaptureState('capturing')
  }, [stopCapture, rebuildFromStills])

  const startScreenCapture = useCallback(() => begin(() => requestWindowCapture()), [begin])
  const pausedRef = useRef(preferences.settings.paused)
  useEffect(() => {
    pausedRef.current = preferences.settings.paused
  }, [preferences.settings.paused])

  /**
   * Stitches a recorded video. Works without screen sharing (phones) and processes the
   * file at whatever speed the device manages, without skipping frames.
   *
   * The first seconds are spent learning the HUD and are not drawn, so after the main
   * pass the video is rewound and only that stretch is stitched again (the stitcher
   * relocates itself on the map). Resolves true when the whole video was processed.
   */
  const startVideoFile = useCallback(
    async (file: File): Promise<boolean> => {
      const client = clientRef.current
      if (!client) return false
      stopRef.current?.()
      setError(null)
      if (typeof VideoFrame === 'undefined') {
        setError('This browser is too old to read video frames. Update it, or use Chrome, Edge or Safari 16.4+.')
        return false
      }
      setCaptureState('starting')
      const video = document.createElement('video')
      video.className = 'size-full object-fill' // shown by LivePreview
      const release = () => {
        video.pause()
        if (video.src) URL.revokeObjectURL(video.src)
        video.removeAttribute('src')
        video.load()
      }
      try {
        await loadVideoFile(file, video)
      } catch (err) {
        release()
        setCaptureState('idle')
        setError(err instanceof Error ? err.message : String(err))
        return false
      }

      let active = true
      const stop = () => {
        active = false
        client.stop()
        release()
        setFileVideo(null)
        setVideoProgress(null)
        setCaptureState('idle')
      }
      stopRef.current = stop
      setFileVideo(video)
      setVideoProgress(0)
      setVideoPass('main')
      setCaptureState('capturing')
      // Timestamps must keep increasing across the rewind (the stitcher derives pan speed
      // from them), so number the samples instead of using the media time.
      let sample = 0
      /** Media time of the first frame that was not spent on calibration. */
      let calibratedAt = -1
      const pass = (until?: number) =>
        stepThroughVideo(video, {
          interval: 1 / VIDEO_SAMPLE_FPS,
          until,
          isActive: () => active,
          isHeld: () => pausedRef.current,
          onProgress: setVideoProgress,
          onFrame: async (t) => {
            const timestamp = Math.round((sample++ * 1e6) / VIDEO_SAMPLE_FPS)
            // The time in the recording identifies the frame: it can be read again.
            await client.pushFrame(new VideoFrame(video, { timestamp }), t)
            if (calibratedAt < 0 && lastStateRef.current !== 'calibrating') calibratedAt = t
          },
        })
      let completed = false
      try {
        await pass()
        if (active && calibratedAt > 0) {
          setVideoPass('start')
          setVideoProgress(0)
          await pass(calibratedAt)
        }
        if (active && assembleRef.current) {
          // The whole recording has been placed: put the map together from its still
          // frames, in large patches.
          setVideoPass('assemble')
          setVideoProgress(0)
          await client.rebuild(async (t) => {
            if (!active) return null
            await seek(video, t)
            return active ? new VideoFrame(video, { timestamp: 0 }) : null
          }, setVideoProgress)
        }
        completed = active
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
      if (active && stopRef.current === stop) stopCapture()
      return completed
    },
    [stopCapture],
  )
  const startDemo = useCallback(() => begin(() => syntheticStream()), [begin])

  /**
   * Stitches screenshots into the map. Their order does not matter; each has to
   * overlap the others (or the existing map) by about a quarter.
   */
  const stitchImages = useCallback(async (files: File[]): Promise<ImageBatchResult | null> => {
    const client = clientRef.current
    if (!client || files.length === 0) return null
    setError(null)
    setBusy('images')
    try {
      const problems: ImageBatchResult['problems'] = []
      const names: string[] = []
      const bitmaps: ImageBitmap[] = []
      for (const file of files) {
        try {
          bitmaps.push(await createImageBitmap(file))
          names.push(file.name)
        } catch {
          problems.push({ name: file.name, reason: 'The browser could not read it as an image.' })
        }
      }
      if (bitmaps.length === 0) return { total: files.length, placed: 0, skipped: [], hudLearned: false, problems }
      const result = await client.stitchImages(bitmaps)
      for (const s of result.skipped) problems.push({ name: names[s.index], reason: s.reason })
      return { ...result, total: files.length, problems }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => () => stopRef.current?.(), [])

  const updateSettings = useCallback((patch: Partial<StitchSettings>) => {
    setPreferences((p) => ({ ...p, settings: { ...p.settings, ...patch } }))
  }, [])
  const setMaxWidth = useCallback((maxWidth: number) => setPreferences((p) => ({ ...p, maxWidth })), [])
  const setAssembleFromStills = useCallback(
    (assembleFromStills: boolean) => setPreferences((p) => ({ ...p, assembleFromStills })),
    [],
  )
  const resetPreferences = useCallback(() => setPreferences(DEFAULT_PREFERENCES), [])

  const clearMap = useCallback(() => {
    clientRef.current?.clearMap()
    setStatus(null)
  }, [])
  const resetUiMask = useCallback(() => clientRef.current?.resetUiMask(), [])

  const requestFullTiles = useCallback((keys: string[]) => {
    const store = tileStore.current
    const wanted: Array<[number, number]> = []
    for (const k of keys) {
      if (store.pending.has(k) || (store.full.has(k) && !store.stale.has(k))) continue
      store.pending.add(k)
      const [tx, ty] = k.split(',').map(Number)
      wanted.push([tx, ty])
    }
    if (wanted.length) clientRef.current?.requestFullTiles(wanted)
  }, [])

  const exportPreview = useCallback(async (): Promise<ExportPreview | null> => {
    const client = clientRef.current
    if (!client) return null
    // An export in the middle of a screen share gets the assembled map too. (Does
    // nothing if nothing was captured since the map was last assembled.)
    if (sharingRef.current && assembleRef.current) await rebuildFromStills()
    try {
      return await client.exportPreview()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [rebuildFromStills])

  const exportPng = useCallback(async (crop?: WorldRect): Promise<ExportResult | null> => {
    const client = clientRef.current
    if (!client) return null
    try {
      // Gaps were already filled for the preview the crop was chosen on.
      return await client.exportPng(crop, undefined, crop ? 0 : undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  return {
    status,
    fps,
    maskBitmap,
    captureState,
    stream,
    fileVideo,
    videoProgress,
    videoPass,
    error,
    dismissError: () => setError(null),
    tileStore,
    tilesVersion,
    tileCount,
    requestFullTiles,
    preferences,
    updateSettings,
    setMaxWidth,
    resetPreferences,
    startScreenCapture,
    startVideoFile,
    startDemo,
    stitchImages,
    rebuildFromStills,
    busy,
    rebuildProgress,
    setAssembleFromStills,
    stopCapture,
    clearMap,
    resetUiMask,
    exportPreview,
    exportPng,
    backgroundCapture: supportsTrackProcessor(),
  }
}

export type StitcherApi = ReturnType<typeof useStitcher>
