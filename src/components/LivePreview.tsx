import { useEffect, useRef, useState } from 'react'
import { MonitorUp } from 'lucide-react'
import type { CropMargins } from '@/stitcher/stitcher'

interface Props {
  stream: MediaStream | null
  /** A video file being processed; shown instead of the stream. */
  fileVideo?: HTMLVideoElement | null
  maskBitmap: ImageBitmap | null
  crop: CropMargins
  showMask: boolean
}

/** The shared window, with cropped margins dimmed and the learned HUD mask in red. */
export function LivePreview({ stream, fileVideo = null, maskBitmap, crop, showMask }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileSlot = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [aspect, setAspect] = useState(16 / 9)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    if (stream) video.play().catch(() => {})
  }, [stream])

  // The file's video element is owned by the stitcher; just mount it here while it plays
  // (being in the document also keeps mobile browsers decoding it).
  useEffect(() => {
    const slot = fileSlot.current
    if (!slot || !fileVideo) return
    slot.appendChild(fileVideo)
    const updateAspect = () => {
      if (fileVideo.videoWidth && fileVideo.videoHeight) setAspect(fileVideo.videoWidth / fileVideo.videoHeight)
    }
    updateAspect()
    fileVideo.addEventListener('resize', updateAspect)
    return () => {
      fileVideo.removeEventListener('resize', updateAspect)
      fileVideo.remove()
    }
  }, [fileVideo])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = 640
    const h = Math.round(w / aspect)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (showMask && maskBitmap) {
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(maskBitmap, 0, 0, w, h)
    }
    // Dim the cropped margins.
    const x0 = crop.left * w
    const x1 = w - crop.right * w
    const y0 = crop.top * h
    const y1 = h - crop.bottom * h
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillRect(0, 0, w, y0)
    ctx.fillRect(0, y1, w, h - y1)
    ctx.fillRect(0, y0, x0, y1 - y0)
    ctx.fillRect(x1, y0, w - x1, y1 - y0)
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
  }, [maskBitmap, crop, showMask, aspect])

  return (
    <div className="relative w-full overflow-hidden rounded-lg border bg-muted/40" style={{ aspectRatio: aspect }}>
      <video
        ref={videoRef}
        muted
        playsInline
        className="absolute inset-0 size-full object-fill"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight)
        }}
        onResize={(e) => {
          const v = e.currentTarget
          if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight)
        }}
      />
      <div ref={fileSlot} className="absolute inset-0" />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" />
      {!stream && !fileVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <MonitorUp className="size-6" />
          <span className="text-xs">Nothing shared or playing</span>
        </div>
      )}
    </div>
  )
}
