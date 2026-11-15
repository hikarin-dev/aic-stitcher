import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { TILE_SIZE, type Mosaic } from '../mosaic'

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
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  writeFileSync(path, Buffer.concat(parts))
}

export function writeMosaicPng(path: string, mosaic: Mosaic): void {
  const b = mosaic.exactBounds()
  if (!b) return
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const out = new Uint8ClampedArray(w * h * 4)
  for (const t of mosaic.tiles.values()) {
    for (let y = 0; y < TILE_SIZE; y++) {
      const wy = t.ty * TILE_SIZE + y - b.minY
      if (wy < 0 || wy >= h) continue
      for (let x = 0; x < TILE_SIZE; x++) {
        const wx = t.tx * TILE_SIZE + x - b.minX
        if (wx < 0 || wx >= w) continue
        const s = (y * TILE_SIZE + x) * 4
        const d = (wy * w + wx) * 4
        out[d] = t.rgba[s]; out[d + 1] = t.rgba[s + 1]; out[d + 2] = t.rgba[s + 2]; out[d + 3] = t.rgba[s + 3]
      }
    }
  }
  writePng(path, out, w, h)
}
