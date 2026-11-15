import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { Crosshair, Maximize, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TileStore } from '@/hooks/useStitcher'
import { cn } from '@/lib/utils'

export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

type Mode = 'fit' | 'follow' | 'free'

interface Props {
  store: RefObject<TileStore>
  version: number
  /** Area of the map currently visible in the game (world coordinates). */
  frame: FrameRect | null
  frameColor: string
  /** Called with tile keys ("tx,ty") whose full-resolution bitmap the viewer would like. */
  onNeedFullTiles?: (keys: string[]) => void
  className?: string
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 8

/** Pan/zoom canvas that draws the downscaled tile previews coming from the worker. */
export function MapViewer({ store, version, frame, frameColor, onNeedFullTiles, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef({ cx: 0, cy: 0, zoom: 0.25 })
  const size = useRef({ w: 1, h: 1, dpr: 1 })
  const raf = useRef(0)
  const frameRef = useRef(frame)
  const [mode, setMode] = useState<Mode>('fit')
  const [zoomPct, setZoomPct] = useState(25)

  useLayoutEffect(() => {
    frameRef.current = frame
  }, [frame])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h, dpr } = size.current
    const { cx, cy, zoom } = view.current
    const { tiles, full, stale, tileSize: T, previewScale } = store.current
    // Previews would be visibly upscaled: use full-resolution tiles instead.
    const wantFull = zoom * previewScale > 1.2
    const missing: string[] = []
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (w / 2 - cx * zoom), dpr * (h / 2 - cy * zoom))
    ctx.imageSmoothingEnabled = zoom < 1
    ctx.imageSmoothingQuality = 'high'
    const left = cx - w / 2 / zoom
    const top = cy - h / 2 / zoom
    const right = cx + w / 2 / zoom
    const bottom = cy + h / 2 / zoom
    // Overlap tiles by half a screen pixel to hide hairline seams.
    const pad = 0.5 / zoom
    for (const [k, t] of tiles) {
      const x = t.tx * T
      const y = t.ty * T
      if (x > right || y > bottom || x + T < left || y + T < top) continue
      const hi = wantFull ? full.get(k) : undefined
      if (wantFull && (!hi || stale.has(k))) missing.push(k)
      ctx.drawImage((hi ?? t).bitmap, x, y, T + pad, T + pad)
    }
    if (missing.length) onNeedFullTiles?.(missing)
    const f = frameRef.current
    if (f) {
      ctx.lineWidth = 2 / zoom
      ctx.strokeStyle = frameColor
      ctx.setLineDash([8 / zoom, 6 / zoom])
      ctx.strokeRect(f.x, f.y, f.w, f.h)
      ctx.setLineDash([])
    }
  }, [store, frameColor, onNeedFullTiles])

  const requestDraw = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      draw()
    })
  }, [draw])

  useEffect(
    () => () => {
      // Reset too: under StrictMode effects unmount/remount, and a stale id here
      // would make requestDraw() think a frame is already pending forever.
      cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const setZoom = useCallback((zoom: number) => {
    view.current.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    setZoomPct(Math.round(view.current.zoom * 100))
  }, [])

  const fit = useCallback(() => {
    const { tiles, tileSize: T } = store.current
    const f = frameRef.current
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const t of tiles.values()) {
      minX = Math.min(minX, t.tx * T)
      minY = Math.min(minY, t.ty * T)
      maxX = Math.max(maxX, (t.tx + 1) * T)
      maxY = Math.max(maxY, (t.ty + 1) * T)
    }
    if (f) {
      minX = Math.min(minX, f.x)
      minY = Math.min(minY, f.y)
      maxX = Math.max(maxX, f.x + f.w)
      maxY = Math.max(maxY, f.y + f.h)
    }
    if (minX === Infinity) return
    const { w, h } = size.current
    view.current.cx = (minX + maxX) / 2
    view.current.cy = (minY + maxY) / 2
    setZoom(Math.min(w / (maxX - minX), h / (maxY - minY)) * 0.92)
  }, [store, setZoom])

  // Follow / fit modes react to new data.
  useEffect(() => {
    if (mode === 'fit') fit()
    else if (mode === 'follow' && frame) {
      view.current.cx = frame.x + frame.w / 2
      view.current.cy = frame.y + frame.h / 2
    }
    requestDraw()
  }, [mode, version, frame, fit, requestDraw])

  // Canvas sizing.
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      size.current = { w: Math.max(1, rect.width), h: Math.max(1, rect.height), dpr }
      canvas.width = Math.round(size.current.w * dpr)
      canvas.height = Math.round(size.current.h * dpr)
      if (mode === 'fit') fit()
      requestDraw()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [fit, mode, requestDraw])

  // Wheel zoom around the cursor (non-passive so we can prevent page scroll).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2
      const v = view.current
      const wx = v.cx + mx / v.zoom
      const wy = v.cy + my / v.zoom
      setZoom(v.zoom * Math.exp(-e.deltaY * 0.0015))
      v.cx = wx - mx / v.zoom
      v.cy = wy - my / v.zoom
      setMode('free')
      requestDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [requestDraw, setZoom])

  const drag = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return
    const v = view.current
    v.cx -= (e.clientX - drag.current.x) / v.zoom
    v.cy -= (e.clientY - drag.current.y) / v.zoom
    drag.current = { x: e.clientX, y: e.clientY }
    if (mode !== 'free') setMode('free')
    requestDraw()
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const zoomBy = (factor: number) => {
    setZoom(view.current.zoom * factor)
    setMode((m) => (m === 'fit' ? 'free' : m))
    requestDraw()
  }

  return (
    <div ref={containerRef} className={cn('relative overflow-hidden', className)}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setMode('fit')}
      />
      <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border bg-background/80 p-1 backdrop-blur">
        <ViewButton label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
          <Minus />
        </ViewButton>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{zoomPct}%</span>
        <ViewButton label="Zoom in" onClick={() => zoomBy(1.5)}>
          <Plus />
        </ViewButton>
        <ViewButton label="Fit whole map (double-click)" active={mode === 'fit'} onClick={() => setMode('fit')}>
          <Maximize />
        </ViewButton>
        <ViewButton label="Follow the camera" active={mode === 'follow'} onClick={() => setMode('follow')}>
          <Crosshair />
        </ViewButton>
      </div>
    </div>
  )
}

function ViewButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant={active ? 'secondary' : 'ghost'} aria-label={label} aria-pressed={active} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
