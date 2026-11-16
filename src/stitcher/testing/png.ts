import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { CONF_CELL, CONF_SIZE, LIGHT_CELL, SHARP_Q, TILE_SIZE, WEAK_Q, type Mosaic } from '../mosaic'

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Debug-only RGBA PNG writer (Node). */
export function writePng(path: string, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): void {
  const raw = new Uint8Array((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  writeFileSync(path, Buffer.concat(parts))
}

/** The whole map as displayed (lighting layer applied), as an RGBA image. */
export function renderMosaic(mosaic: Mosaic): { rgba: Uint8ClampedArray; width: number; height: number; x0: number; y0: number } | null {
  const b = mosaic.exactBounds()
  if (!b) return null
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const out = new Uint8ClampedArray(w * h * 4)
  const out32 = new Uint32Array(out.buffer)
  const tile = new Uint32Array(TILE_SIZE * TILE_SIZE)
  for (const t of mosaic.tiles.values()) {
    mosaic.renderTile(t, tile)
    for (let y = 0; y < TILE_SIZE; y++) {
      const wy = t.ty * TILE_SIZE + y - b.minY
      if (wy < 0 || wy >= h) continue
      for (let x = 0; x < TILE_SIZE; x++) {
        const wx = t.tx * TILE_SIZE + x - b.minX
        if (wx < 0 || wx >= w) continue
        out32[wy * w + wx] = tile[y * TILE_SIZE + x]
      }
    }
  }
  return { rgba: out, width: w, height: h, x0: b.minX, y0: b.minY }
}

/** A world rectangle of the map as displayed (empty pixels transparent). */
export function writeRegionPng(path: string, mosaic: Mosaic, x0: number, y0: number, w: number, h: number): void {
  const out = new Uint8ClampedArray(w * h * 4)
  const out32 = new Uint32Array(out.buffer)
  const tile = new Uint32Array(TILE_SIZE * TILE_SIZE)
  for (const t of mosaic.tiles.values()) {
    const ox = t.tx * TILE_SIZE - x0
    const oy = t.ty * TILE_SIZE - y0
    if (ox >= w || oy >= h || ox + TILE_SIZE <= 0 || oy + TILE_SIZE <= 0) continue
    mosaic.renderTile(t, tile)
    for (let y = Math.max(0, -oy); y < Math.min(TILE_SIZE, h - oy); y++) {
      for (let x = Math.max(0, -ox); x < Math.min(TILE_SIZE, w - ox); x++) {
        out32[(oy + y) * w + ox + x] = tile[y * TILE_SIZE + x]
      }
    }
  }
  writePng(path, out, w, h)
}

export function writeMosaicPng(path: string, mosaic: Mosaic): void {
  const m = renderMosaic(mosaic)
  if (m) writePng(path, m.rgba, m.width, m.height)
}

/**
 * Confidence view at 1/CONF_CELL scale: red = weak (edge-only / contradicted),
 * amber = never captured from a still frame, green = sharp, black = empty.
 */
export function writeConfidencePng(path: string, mosaic: Mosaic): void {
  const b = mosaic.tileBounds()
  if (!b) return
  const w = (b.maxX - b.minX) / CONF_CELL
  const h = (b.maxY - b.minY) / CONF_CELL
  const out = new Uint8ClampedArray(w * h * 4)
  const conf = new Uint8Array(CONF_SIZE * CONF_SIZE)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  for (const t of mosaic.tiles.values()) {
    mosaic.confidence(t, conf)
    const ox = (t.tx * TILE_SIZE - b.minX) / CONF_CELL
    const oy = (t.ty * TILE_SIZE - b.minY) / CONF_CELL
    for (let y = 0; y < CONF_SIZE; y++) {
      for (let x = 0; x < CONF_SIZE; x++) {
        const v = conf[y * CONF_SIZE + x]
        if (v === 0) continue
        const o = ((oy + y) * w + ox + x) * 4
        const [r, g, bl] = v < WEAK_Q ? [220, 40, 40] : v < SHARP_Q ? [230, 170, 30] : [40, 160, 70]
        out[o] = r
        out[o + 1] = g
        out[o + 2] = bl
      }
    }
  }
  writePng(path, out, w, h)
}

/** The lighting layer as a grey image at 1/LIGHT_CELL scale (black = no observation). */
export function writeLightPng(path: string, mosaic: Mosaic): void {
  const b = mosaic.tileBounds()
  if (!b) return
  const w = (b.maxX - b.minX) / LIGHT_CELL
  const h = (b.maxY - b.minY) / LIGHT_CELL
  const cells = TILE_SIZE / LIGHT_CELL
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  for (const t of mosaic.tiles.values()) {
    const ox = (t.tx * TILE_SIZE - b.minX) / LIGHT_CELL
    const oy = (t.ty * TILE_SIZE - b.minY) / LIGHT_CELL
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const light = mosaic.lightAt(t.tx * TILE_SIZE + x * LIGHT_CELL, t.ty * TILE_SIZE + y * LIGHT_CELL)
        if (light <= 0) continue
        const o = ((oy + y) * w + ox + x) * 4
        out[o] = out[o + 1] = out[o + 2] = light
      }
    }
  }
  writePng(path, out, w, h)
}

/** Minimal PNG reader (Node): 8-bit RGB or RGBA, not interlaced. Enough for screenshots. */
export function readPng(path: string): { rgba: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const file = readFileSync(path)
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array[] = []
  for (let o = 8; o < file.length; ) {
    const length = dv.getUint32(o)
    const type = file.toString('latin1', o + 4, o + 8)
    const data = file.subarray(o + 8, o + 8 + length)
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      const [depth, colour, , , interlace] = data.subarray(8)
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0
      if (depth !== 8 || channels === 0 || interlace !== 0) throw new Error(`Unsupported PNG format: ${path}`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    o += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = new Uint8ClampedArray(width * height * 4)
  const line = new Uint8Array(stride)
  const prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = src[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v
    }
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4
      rgba[d] = line[x * channels]
      rgba[d + 1] = line[x * channels + 1]
      rgba[d + 2] = line[x * channels + 2]
      rgba[d + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    prev.set(line)
  }
  return { rgba, width, height }
}
