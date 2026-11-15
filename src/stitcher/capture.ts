/** Frame sources: screen capture, video files and the demo. */
import demoFactoryUrl from '@/assets/demo/aic-factory.webp'
import type { World } from './synthetic'

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessor

function getTrackProcessor(): TrackProcessorCtor | undefined {
  return (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor
}

/** Whether frames can be streamed into the worker (keeps working while the tab is hidden). */
export const supportsTrackProcessor = (): boolean => typeof getTrackProcessor() === 'function'

export const supportsScreenCapture = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices

/** Opens the browser's "choose what to share" dialog, preferring application windows. */
export async function requestWindowCapture(): Promise<MediaStream> {
  const options = {
    video: {
      displaySurface: 'window',
      frameRate: { ideal: 30, max: 60 },
      cursor: 'never',
    },
    audio: false,
    // Chrome-specific hints: don't offer this tab, allow switching the shared window.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  }
  return navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions)
}

/** Loads a local video file into `video` and waits until it can be seeked frame by frame. */
export async function loadVideoFile(file: File, video: HTMLVideoElement): Promise<void> {
  video.muted = true
  video.playsInline = true
  video.loop = false
  video.preload = 'auto'
  video.src = URL.createObjectURL(file)
  await new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2) return resolve()
    const done = (ok: boolean) => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('error', onError)
      if (ok) resolve()
      else reject(new Error("This browser can't play that video. Try an MP4 (H.264) recording."))
    }
    const onLoaded = () => done(true)
    const onError = () => done(false)
    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('error', onError)
    // iOS ignores preload until the video is played once (muted inline playback is allowed).
    video
      .play()
      .then(() => video.pause())
      .catch(() => {})
  })
  video.pause()
  // Files recorded with MediaRecorder (e.g. Chrome WebM) often report an infinite
  // duration until the browser has looked at the end of the file.
  if (!Number.isFinite(video.duration)) {
    await new Promise<void>((resolve) => {
      const onChange = () => {
        if (!Number.isFinite(video.duration)) return
        video.removeEventListener('durationchange', onChange)
        resolve()
      }
      video.addEventListener('durationchange', onChange)
      video.currentTime = 1e101
    })
  }
  if (!(video.duration > 0)) throw new Error("Couldn't read the video's length. Try an MP4 (H.264) recording.")
}

export interface VideoStepOptions {
  /** Seconds of video between processed frames. */
  interval: number
  /** Stop at this time (seconds). Default: the end. */
  until?: number
  /**
   * Called with the video paused on the frame at media time `t`. It must grab the frame
   * synchronously (e.g. `new VideoFrame(video)` before its first `await`): the returned
   * promise is awaited only after the video has already seeked to the next sample.
   */
  onFrame: (t: number) => Promise<void>
  /** Return false to stop. */
  isActive: () => boolean
  /** Return true to hold the video where it is (user pressed Pause). */
  isHeld: () => boolean
  onProgress: (fraction: number) => void
}

/**
 * Walks through a video file, processing one frame every `interval` seconds of video.
 *
 * The video stays paused and is seeked to each sample time, so every sample is
 * processed no matter how slow the device is, and it keeps working in a background
 * tab (playback-driven frame callbacks are throttled there, which used to skip frames).
 * Needs no `captureStream()`, which iOS Safari lacks.
 */
export async function stepThroughVideo(video: HTMLVideoElement, opts: VideoStepOptions): Promise<void> {
  const { interval, onFrame, isActive, isHeld, onProgress } = opts
  const end = Math.min(opts.until ?? Infinity, video.duration)
  video.pause()
  // Seeking to sample k+1 overlaps with stitching sample k.
  let pending: Promise<void> | null = null
  try {
    for (let k = 0; ; k++) {
      const t = k * interval
      if (t > end) break
      while (isHeld() && isActive()) await new Promise((r) => setTimeout(r, 100))
      if (!isActive()) break
      await seek(video, t)
      if (pending) await pending
      if (!isActive()) break
      pending = onFrame(t)
      onProgress(Math.min(1, t / end))
    }
  } finally {
    if (pending) await pending
  }
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      if (err) reject(err)
      else resolve()
    }
    const onSeeked = () => done()
    const onError = () => done(new Error('The video could not be decoded at ' + t.toFixed(2) + ' s.'))
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.currentTime = t
  })
}

export function createFrameStream(track: MediaStreamTrack): ReadableStream<VideoFrame> | null {
  const Processor = getTrackProcessor()
  if (!Processor) return null
  // A tiny buffer: when the worker is busy we'd rather skip frames than lag behind.
  return new Processor({ track, maxBufferSize: 2 }).readable
}

/** Decodes an image into a demo world (RGB). */
async function loadImageWorld(url: string): Promise<World> {
  const blob = await (await fetch(url)).blob()
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rgba = ctx.getImageData(0, 0, width, height).data
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]
    rgb[j + 1] = rgba[i + 1]
    rgb[j + 2] = rgba[i + 2]
  }
  return { width, height, rgb }
}

/**
 * "Game" for trying the app (and testing changes) without Endfield: a real stitched
 * AIC map with a fake HUD and drifting cloud lighting on top, panned along a
 * serpentine path and exposed as a 30 fps MediaStream. Falls back to a procedurally
 * generated factory if the image can't be loaded.
 */
export async function syntheticStream(width = 1280, height = 720): Promise<MediaStream> {
  const { makeWorld, renderFrame, sweepPath } = await import('./synthetic')
  const world = await loadImageWorld(demoFactoryUrl).catch(() => makeWorld(width * 2.5, height * 3, 11))
  const forward = sweepPath(world.width, world.height, width, height, 9)
  const path = [...forward, ...forward.slice().reverse()]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const stream = canvas.captureStream(30)
  const track = stream.getVideoTracks()[0]
  let i = 0
  const timer = setInterval(() => {
    if (track.readyState === 'ended') {
      clearInterval(timer)
      return
    }
    const p = path[i % path.length]
    const gain = 1 + 0.15 * Math.sin(i / 90)
    const shadow = 0.2 * (0.5 + 0.5 * Math.sin(i / 130))
    const rgba = renderFrame(world, p.x, p.y, width, height, gain, shadow)
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
    i++
  }, 1000 / 30)
  return stream
}
