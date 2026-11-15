import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Download, Loader2, Lock, LockOpen, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Toggle } from '@/components/ui/toggle'
import type { ExportPreview } from '@/stitcher/client'
import type { WorldRect } from '@/stitcher/protocol'
import { cn } from '@/lib/utils'

/** Same limits the worker applies when rendering the PNG. */
const MAX_SIDE = 16384
const MAX_PIXELS = 200_000_000
const MIN_CROP = 16

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

interface Drag {
  kind: Corner | 'move'
  pointerX: number
  pointerY: number
  start: WorldRect
}

interface Props {
  open: boolean
  /** Null while the worker is still rendering the preview. */
  preview: ExportPreview | null
  exporting: boolean
  onCancel: () => void
  /** `crop` is in world coordinates. */
  onExport: (crop: WorldRect) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Largest centered square inside `r`. */
function squareOf(r: WorldRect): WorldRect {
  const s = Math.min(r.w, r.h)
  return { x: Math.round(r.x + (r.w - s) / 2), y: Math.round(r.y + (r.h - s) / 2), w: s, h: s }
}

export function ExportDialog({ open, preview, exporting, onCancel, onExport }: Props) {
  // Kept across opens so a square export stays square next time.
  const [square, setSquare] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !exporting && onCancel()}>
      <DialogContent className="max-w-3xl" onPointerDownOutside={(e) => exporting && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Export PNG</DialogTitle>
          <DialogDescription>Drag the corners to crop, or drag inside the box to move it.</DialogDescription>
        </DialogHeader>
        {preview ? (
          <CropEditor
            preview={preview}
            square={square}
            onSquareChange={setSquare}
            exporting={exporting}
            onCancel={onCancel}
            onExport={onExport}
          />
        ) : (
          <>
            <div className="map-backdrop flex min-h-48 items-center justify-center rounded-lg">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface EditorProps {
  preview: ExportPreview
  square: boolean
  onSquareChange: (on: boolean) => void
  exporting: boolean
  onCancel: () => void
  onExport: (crop: WorldRect) => void
}

function CropEditor({ preview, square, onSquareChange, exporting, onCancel, onExport }: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag | null>(null)
  const { w: W, h: H } = preview.bounds
  const full = { x: 0, y: 0, w: W, h: H }
  // Crop relative to the map bounds (0..W, 0..H), in world pixels.
  const [crop, setCrop] = useState<WorldRect>(() => (square ? squareOf(full) : full))
  const minSide = Math.min(MIN_CROP, W, H)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = preview.bitmap.width
    canvas.height = preview.bitmap.height
    canvas.getContext('2d')?.drawImage(preview.bitmap, 0, 0)
  }, [preview])

  const toggleSquare = (on: boolean) => {
    onSquareChange(on)
    if (on) setCrop(squareOf(crop))
  }

  const reset = () => setCrop(square ? squareOf(full) : full)

  /** Pointer position in world pixels relative to the map bounds. */
  const toWorld = (e: ReactPointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H }
  }

  const startDrag = (kind: Drag['kind']) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toWorld(e)
    drag.current = { kind, pointerX: p.x, pointerY: p.y, start: crop }
  }

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const p = toWorld(e)
    const s = d.start
    if (d.kind === 'move') {
      setCrop({
        ...s,
        x: Math.round(clamp(s.x + p.x - d.pointerX, 0, W - s.w)),
        y: Math.round(clamp(s.y + p.y - d.pointerY, 0, H - s.h)),
      })
      return
    }
    // The opposite corner stays put; the crop can't flip past it.
    const sx = d.kind === 'ne' || d.kind === 'se' ? 1 : -1
    const sy = d.kind === 'sw' || d.kind === 'se' ? 1 : -1
    const ax = sx > 0 ? s.x : s.x + s.w
    const ay = sy > 0 ? s.y : s.y + s.h
    const availX = sx > 0 ? W - ax : ax
    const availY = sy > 0 ? H - ay : ay
    let w = clamp((clamp(p.x, 0, W) - ax) * sx, minSide, availX)
    let h = clamp((clamp(p.y, 0, H) - ay) * sy, minSide, availY)
    if (square) w = h = Math.min(Math.max(w, h), availX, availY)
    w = Math.round(w)
    h = Math.round(h)
    setCrop({ x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h })
  }

  const endDrag = () => {
    drag.current = null
  }

  const scale = Math.min(1, MAX_SIDE / crop.w, MAX_SIDE / crop.h, Math.sqrt(MAX_PIXELS / (crop.w * crop.h)))
  const outW = Math.max(1, Math.round(crop.w * scale))
  const outH = Math.max(1, Math.round(crop.h * scale))
  const pct = (v: number, of: number) => `${(v / of) * 100}%`

  return (
    <>
      <div className="map-backdrop flex min-h-48 items-center justify-center overflow-hidden rounded-lg p-3">
        <div className="relative select-none">
          <canvas ref={canvasRef} className="block max-h-[min(60dvh,36rem)] max-w-full" />
          <div className="absolute inset-0 overflow-hidden">
            <div
              className="absolute cursor-move touch-none border border-white/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] outline outline-black/40"
              style={{ left: pct(crop.x, W), top: pct(crop.y, H), width: pct(crop.w, W), height: pct(crop.h, H) }}
              onPointerDown={startDrag('move')}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          </div>
          {/* Handles sit outside the clipping layer so they stay grabbable at the edges. */}
          {CORNERS.map((c) => (
            <div
              key={c}
              aria-hidden
              className={cn(
                'absolute z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center',
                c === 'nw' || c === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize',
              )}
              style={{
                left: pct(c === 'nw' || c === 'sw' ? crop.x : crop.x + crop.w, W),
                top: pct(c === 'nw' || c === 'ne' ? crop.y : crop.y + crop.h, H),
              }}
              onPointerDown={startDrag(c)}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <span className="size-3 rounded-[3px] border border-black/50 bg-white shadow" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Toggle variant="outline" size="sm" pressed={square} onPressedChange={toggleSquare} disabled={exporting}>
          {square ? <Lock /> : <LockOpen />} Lock 1:1
        </Toggle>
        <Button variant="ghost" size="sm" onClick={reset} disabled={exporting}>
          <RotateCcw /> Reset
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {outW.toLocaleString()} × {outH.toLocaleString()} px
          {scale < 1 && ` (scaled to ${Math.round(scale * 100)}%)`}
        </span>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={exporting}>
          Cancel
        </Button>
        <Button
          disabled={exporting}
          onClick={() => onExport({ x: preview.bounds.x + crop.x, y: preview.bounds.y + crop.y, w: crop.w, h: crop.h })}
        >
          {exporting ? <Loader2 className="animate-spin" /> : <Download />}
          Export
        </Button>
      </DialogFooter>
    </>
  )
}
