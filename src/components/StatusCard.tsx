import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import type { StitcherApi } from '@/hooks/useStitcher'
import { TILE_SIZE } from '@/stitcher/mosaic'

// Per pixel: colour 4 + frame brightness 2 + luma, quality, confirmations 1 each. The lighting layer adds ~0.15 MB.
const BYTES_PER_TILE = TILE_SIZE * TILE_SIZE * 9 + 150_000
/** Share of the current view that contradicts the map above which the user is told. */
const DISAGREEMENT_HINT = 0.12

const percent = (v: number) => `${(v * 100).toFixed(v < 0.095 ? 1 : 0)}%`

export function StatusCard({ api }: { api: StitcherApi }) {
  const { status, fps, captureState, preferences } = api
  const capturing = captureState === 'capturing'

  let badge: { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
  if (!capturing) badge = { label: 'Idle', variant: 'outline' }
  else if (!status) badge = { label: 'Waiting for frames', variant: 'secondary' }
  else if (status.state === 'lost') badge = { label: 'Lost', variant: 'destructive' }
  else if (status.state === 'calibrating') badge = { label: 'Learning HUD', variant: 'secondary' }
  else if (preferences.settings.paused) badge = { label: 'Paused', variant: 'secondary' }
  else badge = { label: 'Stitching', variant: 'default' }

  const tiles = status?.tileCount ?? 0
  const memMb = (tiles * BYTES_PER_TILE) / (1024 * 1024)

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardAction>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {capturing && status?.state === 'calibrating' && (
          <div className="flex flex-col gap-1.5">
            <Progress value={status.calibration * 100} />
            <p className="text-xs text-muted-foreground">
              Pan the camera around a bit so the HUD can be told apart from the map.
            </p>
          </div>
        )}
        {capturing && status?.state === 'lost' && (
          <p className="text-xs text-destructive">
            Can't place the current view on the map. Close any menus, keep the same zoom level and move the camera over
            any part of the map that's already captured; it snaps back automatically.
          </p>
        )}
        {capturing && status?.state === 'tracking' && status.disagreement > DISAGREEMENT_HINT && (
          <p className="text-xs text-amber-400">
            This view looks different from what the map has here (things moved, or an earlier pass was blurry). Hold
            the camera still for a moment: still frames are the sharpest and replace it.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <Stat label="Frames / s" value={capturing ? fps.toFixed(0) : '–'} />
          <Stat label="Frame time" value={status ? `${status.processMs.toFixed(1)} ms` : '–'} />
          <Stat label="Capture" value={status ? `${status.width}×${status.height}` : '–'} />
          <Stat label="Position" value={status ? `${status.x}, ${status.y}` : '–'} />
          <Stat label="Match" value={status?.matchScore != null ? status.matchScore.toFixed(2) : '–'} />
          <Stat label="Low confidence" value={status ? percent(status.weak) : '–'} />
          <Stat label="Not yet sharp" value={status ? percent(status.soft) : '–'} />
          <Stat label="Map tiles" value={String(tiles)} />
          <Stat label="Memory" value={`${memMb.toFixed(0)} MB`} />
          <Stat label="Last draw" value={status?.drawMode ?? '–'} />
          <Stat label="Still frames" value={status ? String(status.keyframes) : '–'} />
        </dl>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
