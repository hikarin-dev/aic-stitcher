// Generates docs/pipeline.svg, the pipeline diagram in the README.
// Run `npm run docs:diagram` after editing. No dependencies: plain SVG strings.
import { writeFileSync } from 'node:fs'

const W = 1120
const H = 640

const C = {
  bg: '#ffffff',
  panel: '#f6f8fa',
  border: '#d0d7de',
  text: '#1f2328',
  muted: '#59636e',
  arrow: '#8c959f',
  yellow: '#d4a72c',
  blue: '#0969da',
  green: '#1a7f37',
  red: '#cf222e',
  purple: '#8250df',
}

const parts = []
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function text(x, y, s, { size = 14, weight = 400, color = C.text, anchor = 'start' } = {}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}</text>`)
}
/** A rounded card with an optional coloured accent bar on the left. Returns the text x. */
function card(x, y, w, h, { accent, fill = C.bg } = {}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${C.border}"/>`)
  if (accent) {
    parts.push(`<path d="M${x + 8} ${y} h-0 a8 8 0 0 0 -8 8 v${h - 16} a8 8 0 0 0 8 8 h4 v-${h} z" fill="${accent}"/>`)
  }
  return x + (accent ? 22 : 16)
}
function titled(x, y, w, h, title, sub, opts) {
  const tx = card(x, y, w, h, opts)
  const subs = Array.isArray(sub) ? sub : [sub]
  const top = y + h / 2 - (subs.length * 18) / 2 + 2
  text(tx, top, title, { size: 15, weight: 600 })
  subs.forEach((s, i) => text(tx, top + 19 + i * 18, s, { size: 13, color: C.muted }))
}
/** Polyline arrow through the given points. */
function arrow(points, { color = C.arrow, dashed = false } = {}) {
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const marker = color === C.arrow ? 'a' : `a-${color.slice(1)}`
  parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#${marker})"/>`)
}
function label(x, y, s, color = C.muted, anchor = 'start') {
  text(x, y, s, { size: 12, weight: 600, color, anchor })
}

// ---- column headers
const colY = 46
text(40, colY, 'FRAME SOURCES', { size: 12, weight: 700, color: C.muted })
text(330, colY, 'WEB WORKER', { size: 12, weight: 700, color: C.muted })
text(428, colY, 'Stitcher.process(frame)', { size: 12, color: C.muted })
text(914, colY, 'UI THREAD (REACT)', { size: 12, weight: 700, color: C.muted })

// ---- sources
const SX = 40
const SW = 240
const SH = 72
const srcY = (i) => 70 + i * 92
const sources = [
  ['Share game window', 'live, desktop Chrome / Edge', C.yellow],
  ['Open recording', 'frame by frame, works on phones', C.blue],
  ['Demo', 'real AIC map, fake HUD on top', C.green],
]
sources.forEach(([t, s, accent], i) => titled(SX, srcY(i), SW, SH, t, s, { accent }))

// ---- worker panel
const WX = 316
const WY = 60
const WW = 556
const WH = 560
parts.push(`<rect x="${WX}" y="${WY}" width="${WW}" height="${WH}" rx="12" fill="${C.panel}" stroke="${C.border}"/>`)

const steps = [
  ['Prepare', 'luma + downscaled copies'],
  ['Coarse motion', 'phase correlation (FFT)'],
  ['Fine alignment', 'block ZNCC against the map'],
  ['Learn the HUD', 'pixels that stay put while panning'],
  ['Split lighting', 'frame brightness apart from detail'],
  ['Composite', 'one sample per object, shared lighting'],
]
const STX = WX + 24
const STW = 290
const STH = 64
const stepY = (i) => WY + 24 + i * 89
steps.forEach(([t, s], i) => {
  const y = stepY(i)
  card(STX, y, STW, STH)
  parts.push(`<circle cx="${STX + 26}" cy="${y + STH / 2}" r="13" fill="${C.text}"/>`)
  text(STX + 26, y + STH / 2 + 5, String(i + 1), { size: 13, weight: 700, color: '#ffffff', anchor: 'middle' })
  text(STX + 50, y + 27, t, { size: 15, weight: 600 })
  text(STX + 50, y + 46, s, { size: 13, color: C.muted })
  if (i < steps.length - 1) arrow([[STX + STW / 2, y + STH], [STX + STW / 2, stepY(i + 1) - 2]])
})
const right = STX + STW

// sources → one connector → step 1
const joinX = 298
const line = (d) => parts.push(`<path d="${d}" fill="none" stroke="${C.arrow}" stroke-width="1.6"/>`)
sources.forEach((_, i) => line(`M${SX + SW} ${srcY(i) + SH / 2} H${joinX}`))
line(`M${joinX} ${srcY(0) + SH / 2} V${srcY(sources.length - 1) + SH / 2}`)
arrow([[joinX, stepY(0) + STH / 2], [STX - 2, stepY(0) + STH / 2]])

// relocalize, off step 3
const RX = right + 56
const RW = 172
const r3 = stepY(2)
titled(RX, r3, RW, STH, 'Relocalize', ['search the whole map', 'after a jump'], { accent: C.red })
arrow([[right, r3 + 22], [RX - 2, r3 + 22]], { color: C.red })
label(right + 8, r3 + 15, 'lost?', C.red)
arrow([[RX, r3 + 44], [right + 2, r3 + 44]])

// mosaic: written by step 6, the reference for steps 3 and 5
const MY = stepY(4)
const MH = stepY(5) + STH - MY
titled(RX, MY, RW, MH, 'Mosaic', ['512 px tiles', 'the reference for', 'steps 3 and 5'], { accent: C.purple })
arrow([[right, stepY(5) + STH / 2], [RX - 2, stepY(5) + STH / 2]])
arrow([[RX, stepY(4) + 32], [right + 2, stepY(4) + 32]], { color: C.purple, dashed: true })
label(right + 4, stepY(4) + 24, 'reference', C.purple)

// ---- UI thread
const UX = 914
const UW = 176
const uiY = (i) => 70 + i * 92
const ui = [
  ['Map viewer', ['¼-res tiles,', 'full-res when zoomed']],
  ['Live preview', ['with the learned', 'HUD mask']],
  ['Export PNG', ['small holes filled in']],
]
const busX = UX - 18
ui.forEach(([t, s], i) => {
  titled(UX, uiY(i), UW, SH, t, s)
  arrow([[busX, uiY(i) + SH / 2], [UX - 2, uiY(i) + SH / 2]])
})
const busY = MY + 40
parts.push(`<path d="M${RX + RW} ${busY} H${busX} V${uiY(0) + SH / 2}" fill="none" stroke="${C.arrow}" stroke-width="1.6"/>`)
label(busX + 8, busY - 8, 'tiles, status')
text(UX, 360, 'Everything runs locally:', { size: 12, color: C.muted })
text(UX, 377, 'no frames leave the device.', { size: 12, color: C.muted })

const markers = [C.arrow, C.red, C.purple]
  .map((c) => {
    const id = c === C.arrow ? 'a' : `a-${c.slice(1)}`
    return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${c}"/></marker>`
  })
  .join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stitching pipeline: frame sources feed a web worker that prepares each frame, estimates motion, aligns it to the map, learns the HUD, separates lighting from detail and composites into a tiled mosaic, which the UI thread displays and exports.">
<defs>${markers}</defs>
<style>text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; }</style>
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
${parts.join('\n')}
</svg>
`
writeFileSync(new URL('./pipeline.svg', import.meta.url), svg)
console.log(`wrote docs/pipeline.svg (${(svg.length / 1024).toFixed(1)} KB)`)
