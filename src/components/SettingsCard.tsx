import { Eraser, RotateCcw, ScanEye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { StitcherApi } from '@/hooks/useStitcher'
import type { CropMargins } from '@/stitcher/stitcher'

const CROP_SIDES: Array<{ key: keyof CropMargins; label: string }> = [
  { key: 'top', label: 'Top' },
  { key: 'bottom', label: 'Bottom' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
]

const RESOLUTIONS = [
  { value: 1280, label: '720p' },
  { value: 1920, label: '1080p' },
  { value: 2560, label: '1440p' },
  { value: 0, label: 'Native' },
]

interface Props {
  api: StitcherApi
  showMask: boolean
  onShowMaskChange: (v: boolean) => void
}

export function SettingsCard({ api, showMask, onShowMaskChange }: Props) {
  const { settings, maxWidth } = api.preferences
  const setCrop = (key: keyof CropMargins, value: number) =>
    api.updateSettings({ crop: { ...settings.crop, [key]: value } })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <Label>Crop margins</Label>
            <span className="text-xs text-muted-foreground">always excluded</span>
          </div>
          {CROP_SIDES.map(({ key, label }) => (
            <div key={key} className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Slider
                min={0}
                max={0.4}
                step={0.005}
                value={[settings.crop[key]]}
                onValueChange={([v]) => setCrop(key, v)}
                aria-label={`${label} crop`}
              />
              <span className="text-right text-xs tabular-nums">{Math.round(settings.crop[key] * 100)}%</span>
            </div>
          ))}
        </section>

        <Separator />

        <SwitchRow
          id="auto-hud"
          label="Detect HUD automatically"
          hint="Learns which pixels stay fixed while the map scrolls."
          checked={settings.autoUiMask}
          onChange={(v) => api.updateSettings({ autoUiMask: v })}
        />
        <SwitchRow
          id="show-mask"
          label="Show HUD mask in preview"
          checked={showMask}
          onChange={onShowMaskChange}
        />
        <SwitchRow
          id="lighting"
          label="Correct lighting changes"
          hint="Matches brightness to the map (cloud shadows)."
          checked={settings.lightingCorrection}
          onChange={(v) => api.updateSettings({ lightingCorrection: v })}
        />

        <Separator />

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <Label>Skip frames faster than</Label>
            <span className="text-xs tabular-nums">
              {settings.maxSpeed > 0 ? `${settings.maxSpeed} px/s` : 'off'}
            </span>
          </div>
          <Slider
            min={0}
            max={6000}
            step={250}
            value={[settings.maxSpeed]}
            onValueChange={([v]) => api.updateSettings({ maxSpeed: v })}
            aria-label="Maximum camera speed"
          />
          <p className="text-xs text-muted-foreground">Avoids motion blur. Tracking continues either way.</p>
        </section>

        <section className="flex flex-col gap-2">
          <Label>Processing resolution</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(maxWidth)}
            onValueChange={(v) => v && api.setMaxWidth(Number(v))}
            className="w-full"
          >
            {RESOLUTIONS.map((r) => (
              <ToggleGroupItem key={r.value} value={String(r.value)} className="flex-1">
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            Lower is faster. A change takes effect after Clear map (the map keeps one scale).
          </p>
        </section>

        <Separator />

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={api.resetUiMask}>
            <ScanEye /> Re-learn HUD
          </Button>
          <Button variant="outline" size="sm" onClick={api.resetPreferences}>
            <RotateCcw /> Defaults
          </Button>
          <Button variant="destructive" size="sm" onClick={api.clearMap}>
            <Eraser /> Clear map
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
