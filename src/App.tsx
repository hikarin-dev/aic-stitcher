import { type ReactNode, useEffect, useRef, useState } from 'react'
import { AlertCircle, Download, FolderOpen, FlaskConical, Info, Loader2, MonitorUp, Pause, Play, Square } from 'lucide-react'
import { ExportDialog } from '@/components/ExportDialog'
import { LivePreview } from '@/components/LivePreview'
import { MapViewer } from '@/components/MapViewer'
import { SettingsCard } from '@/components/SettingsCard'
import { StatusCard } from '@/components/StatusCard'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useStitcher } from '@/hooks/useStitcher'
import { supportsScreenCapture } from '@/stitcher/capture'
import type { ExportPreview } from '@/stitcher/client'
import type { WorldRect } from '@/stitcher/protocol'

const FRAME_COLOR = 'rgb(250 204 21)'
/** Phones and tablets have no screen-capture API; recordings are the only way in. */
const CAN_SHARE = supportsScreenCapture()

export default function App() {
  const api = useStitcher()
  const [showMask, setShowMask] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null)
  /** Bumped on every open/close so a late preview from a cancelled dialog is dropped. */
  const exportSession = useRef(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const { status, captureState, preferences, tileStore, tilesVersion, tileCount, videoProgress } = api
  const capturing = captureState === 'capturing'
  const starting = captureState === 'starting'
  const openRecording = () => fileInput.current?.click()
  const startFile = (file: File) => {
    void api.startVideoFile(file).then((done) => {
      if (done) setNotice('Finished stitching the recording. Export it, or open another one to extend the map.')
    })
  }
  const stitchImages = (files: File[]) => {
    void api.stitchImages(files).then((r) => {
      if (!r) return
      const first = r.problems[0]
      setNotice(
        `Stitched ${r.placed} of ${r.total} image${r.total === 1 ? '' : 's'}.` +
          (first ? ` ${first.name}: ${first.reason}` : '') +
          (r.problems.length > 1 ? ` (and ${r.problems.length - 1} more)` : ''),
      )
    })
  }
  /** A recording, or any number of screenshots. */
  const openFiles = (files: File[]) => {
    const video = files.find((f) => f.type.startsWith('video/'))
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (video) startFile(video)
    else if (images.length > 0) stitchImages(images)
    else if (files.length > 0) setNotice("That isn't a video or an image. Open a screen recording (MP4, WebM, MOV) or screenshots (PNG, JPEG).")
  }
  const working = api.busy !== null
  // A recording being read, or the map being assembled from its still frames.
  const progress = videoProgress ?? (api.busy === 'rebuild' ? api.rebuildProgress : null)
  const paused = preferences.settings.paused
  const hasMap = tileCount > 0
  const frame = capturing && status ? { x: status.x, y: status.y, w: status.width, h: status.height } : null

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const closeExport = () => {
    exportSession.current++
    setExportOpen(false)
    setExportPreview((p) => {
      p?.bitmap.close()
      return null
    })
  }

  const openExport = async () => {
    const session = ++exportSession.current
    setExportOpen(true)
    const preview = await api.exportPreview()
    if (session !== exportSession.current) {
      preview?.bitmap.close()
      return
    }
    if (preview) setExportPreview(preview)
    else closeExport()
  }

  const onExport = async (crop: WorldRect) => {
    setExporting(true)
    const result = await api.exportPng(crop)
    setExporting(false)
    if (!result) return
    closeExport()
    const url = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    a.href = url
    a.download = `aic-map-${stamp}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setNotice(
      `Exported ${result.width}×${result.height} px` +
        (result.scale < 1 ? ` (scaled to ${Math.round(result.scale * 100)}% to fit browser canvas limits)` : ''),
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            {/* A plain link to the page itself: clicking the logo or the title reloads the app. */}
            <a
              href="./"
              title="Reload AIC Stitcher"
              className="flex items-center gap-2.5 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* 96×87 like the file, so the rounded corners sit on the artwork itself. */}
              <img
                src={`${import.meta.env.BASE_URL}logo.webp`}
                alt=""
                width={96}
                height={87}
                className="h-8 w-auto shrink-0 rounded-md"
              />
              <h1 className="font-heading text-base font-semibold tracking-tight">AIC Stitcher</h1>
            </a>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Endfield factory map, stitched in your browser
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {capturing ? (
              <Button variant="outline" onClick={api.stopCapture}>
                <Square /> {videoProgress !== null ? 'Stop' : 'Stop sharing'}
              </Button>
            ) : (
              <>
                {CAN_SHARE && (
                  <Button onClick={api.startScreenCapture} disabled={starting}>
                    {starting ? <Loader2 className="animate-spin" /> : <MonitorUp />}
                    Share game window
                  </Button>
                )}
                <Button variant={CAN_SHARE ? 'outline' : 'default'} onClick={openRecording} disabled={starting || working}>
                  {(starting && !CAN_SHARE) || working ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                  Open files
                </Button>
              </>
            )}
            <Button
              variant="outline"
              disabled={!capturing}
              onClick={() => api.updateSettings({ paused: !paused })}
            >
              {paused ? <Play /> : <Pause />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="secondary" disabled={!hasMap || exportOpen} onClick={openExport}>
              <Download />
              Export PNG
            </Button>
          </div>
        </header>
        {progress !== null && (
          <div className="flex items-center gap-3 border-b px-4 py-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">
              {api.busy === 'rebuild' || api.videoPass === 'assemble'
                ? 'Assembling the map from its still frames'
                : paused
                  ? 'Paused'
                  : api.videoPass === 'start'
                    ? 'Filling in the start (used for HUD detection)'
                    : 'Stitching recording'}
            </span>
            <Progress value={progress * 100} className="flex-1" />
            <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
        )}

        {(api.error || notice || (!CAN_SHARE && !hasMap && !capturing)) && (
          <div className="flex flex-col gap-2 border-b px-4 py-2">
            {!CAN_SHARE && !hasMap && !capturing && (
              <Alert>
                <Info />
                <AlertTitle>Live sharing needs a desktop browser</AlertTitle>
                <AlertDescription>
                  Phones and tablets can't share another app's screen with a web page. Screen-record yourself panning
                  around the AIC instead, then open the recording here.
                </AlertDescription>
              </Alert>
            )}
            {api.error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription>{api.error}</AlertDescription>
                <AlertAction>
                  <Button size="sm" variant="ghost" onClick={api.dismissError}>
                    Dismiss
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {notice && (
              <Alert>
                <Download />
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* On narrow screens (phones) the map comes first and the panel follows it. */}
          <aside className="order-last flex w-full shrink-0 flex-col gap-3 overflow-y-auto *:shrink-0 border-t p-3 lg:order-none lg:w-88 lg:border-t-0 lg:border-r">
            <LivePreview
              stream={api.stream}
              fileVideo={api.fileVideo}
              maskBitmap={api.maskBitmap}
              crop={preferences.settings.crop}
              showMask={showMask}
            />
            <StatusCard api={api} />
            <SettingsCard api={api} showMask={showMask} onShowMaskChange={setShowMask} />
            {capturing && !api.backgroundCapture && (
              <p className="text-xs text-amber-400">
                This browser can't stream frames to a worker, so capture slows down while this tab is in the
                background. Chrome or Edge work best.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>No game at hand?</span>
              <Button variant="ghost" size="xs" onClick={api.startDemo} disabled={capturing}>
                <FlaskConical /> Demo
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="video/*,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                openFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </aside>

          <section
            className="map-backdrop relative min-h-[60vh] flex-1 lg:min-h-0"
            onDragOver={(e) => {
              if (capturing || !e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              setDragging(false)
              const files = Array.from(e.dataTransfer.files)
              if (files.length === 0 || capturing) return
              e.preventDefault()
              openFiles(files)
            }}
          >
            <MapViewer
              store={tileStore}
              version={tilesVersion}
              frame={frame}
              frameColor={FRAME_COLOR}
              onNeedFullTiles={api.requestFullTiles}
              className="absolute inset-0"
            />
            {!hasMap && (
              <HowTo
                capturing={capturing}
                fromFile={videoProgress !== null}
                starting={starting}
                onShare={api.startScreenCapture}
                onOpenRecording={openRecording}
              />
            )}
            {dragging && (
              <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/70 text-sm font-medium">
                Drop a recording or screenshots to stitch them
              </div>
            )}
          </section>
        </main>
        <ExportDialog
          open={exportOpen}
          preview={exportPreview}
          exporting={exporting}
          onCancel={closeExport}
          onExport={onExport}
        />
      </div>
    </TooltipProvider>
  )
}

interface HowToProps {
  capturing: boolean
  fromFile: boolean
  starting: boolean
  onShare: () => void
  onOpenRecording: () => void
}

function HowTo({ capturing, fromFile, starting, onShare, onOpenRecording }: HowToProps) {
  if (capturing) {
    return (
      <Overlay>
        <h2 className="mb-2 font-heading text-base font-semibold">
          {fromFile ? 'Reading the recording…' : 'Now pan around the factory'}
        </h2>
        <p className="text-muted-foreground">
          {fromFile
            ? 'The first second or two is used to learn which pixels belong to the HUD, then the map starts filling in.'
            : 'Pan with a fixed zoom level and stop for a moment every screen or so: frames taken while the camera stands still are the sharpest. For the first second or two the app learns which pixels belong to the HUD, then the map starts filling in.'}
        </p>
      </Overlay>
    )
  }

  const share = (
    <Option
      key="share"
      icon={<MonitorUp />}
      title="Share the game window live"
      action={
        <Button size="sm" onClick={onShare} disabled={starting}>
          <MonitorUp /> Share game window
        </Button>
      }
    >
      Desktop Chrome or Edge. Run Endfield windowed or borderless, open the AIC top-down view, share the window and
      pan around.
    </Option>
  )
  const record = (
    <Option
      key="record"
      icon={<FolderOpen />}
      title="Stitch a recording or screenshots"
      action={
        <Button size="sm" variant={CAN_SHARE ? 'outline' : 'default'} onClick={onOpenRecording} disabled={starting}>
          <FolderOpen /> Open files
        </Button>
      }
    >
      {CAN_SHARE
        ? 'Works on phones too. Screen-record the AIC top-down view while you pan, or take screenshots that overlap by a third or so, then open them or drop them here.'
        : 'Screen-record the AIC top-down view while you pan, or take screenshots that overlap by a third or so, then open them.'}
    </Option>
  )

  return (
    <Overlay>
      <h2 className="mb-3 font-heading text-base font-semibold">
        {CAN_SHARE ? 'Two ways to build the map' : 'Build the map from a recording'}
      </h2>
      {/* Live sharing can't work here (phones); the banner above explains why. */}
      <div className="flex flex-col gap-3">{CAN_SHARE ? [share, record] : record}</div>
      <p className="mt-4 text-xs text-muted-foreground">
        Keep the zoom level fixed and close menus while panning (use Pause if you need one). Export PNG downloads the
        full-resolution map. Everything runs locally; nothing is uploaded.
      </p>
    </Overlay>
  )
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-y-auto p-4 sm:p-6">
      <div className="pointer-events-auto max-w-md rounded-xl border bg-background/85 p-5 text-sm shadow-lg backdrop-blur">
        {children}
      </div>
    </div>
  )
}

function Option({ icon, title, action, children }: { icon: ReactNode; title: string; action: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border bg-muted/30 p-3 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-primary">
      {icon}
      <div className="flex min-w-0 flex-col gap-2">
        <div>
          <div className="font-medium">{title}</div>
          <p className="text-muted-foreground">{children}</p>
        </div>
        <div>{action}</div>
      </div>
    </div>
  )
}

