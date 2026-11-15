/** Deterministic synthetic "factory map" + HUD frames for tests and benchmarks. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface World {
  width: number
  height: number
  rgb: Uint8Array // 3 bytes per pixel
}

/** Ground noise + grid lines + random "machines" and "belts". */
export function makeWorld(width: number, height: number, seed = 1): World {
  width = Math.round(width)
  height = Math.round(height)
  const rand = mulberry32(seed)
  const rgb = new Uint8Array(width * height * 3)

  // Value noise ground (two octaves).
  const cell = 48
  const gw = Math.ceil(width / cell) + 2
  const gh = Math.ceil(height / cell) + 2
  const grid = new Float32Array(gw * gh).map(() => rand())
  const fine = new Float32Array(width * height).map(() => rand())
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / cell
      const v = y / cell
      const x0 = Math.floor(u)
      const y0 = Math.floor(v)
      const fx = u - x0
      const fy = v - y0
      const sx = fx * fx * (3 - 2 * fx)
      const sy = fy * fy * (3 - 2 * fy)
      const a = grid[y0 * gw + x0] * (1 - sx) + grid[y0 * gw + x0 + 1] * sx
      const b = grid[(y0 + 1) * gw + x0] * (1 - sx) + grid[(y0 + 1) * gw + x0 + 1] * sx
      const n = a * (1 - sy) + b * sy
      let val = 70 + n * 60 + (fine[y * width + x] - 0.5) * 14
      if (x % 40 === 0 || y % 40 === 0) val -= 25 // factory grid
      const i = (y * width + x) * 3
      rgb[i] = val * 0.9
      rgb[i + 1] = val
      rgb[i + 2] = val * 1.05
    }
  }

  const fillRect = (x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * 3
        const shade = ((x - x0) % 8 < 1 || (y - y0) % 8 < 1 ? 0.8 : 1) * (0.9 + 0.2 * fine[y * width + x])
        rgb[i] = r * shade
        rgb[i + 1] = g * shade
        rgb[i + 2] = b * shade
      }
    }
  }
  const machines = Math.round((width * height) / 40000)
  for (let k = 0; k < machines; k++) {
    const w = 40 + Math.floor(rand() * 120)
    const h = 40 + Math.floor(rand() * 120)
    fillRect(
      Math.floor(rand() * width),
      Math.floor(rand() * height),
      w,
      h,
      60 + rand() * 180,
      60 + rand() * 180,
      60 + rand() * 180,
    )
  }
  const belts = Math.round((width * height) / 80000)
  for (let k = 0; k < belts; k++) {
    const horizontal = rand() < 0.5
    const len = 200 + Math.floor(rand() * 600)
    const x = Math.floor(rand() * width)
    const y = Math.floor(rand() * height)
    if (horizontal) fillRect(x, y, len, 10, 200, 190, 60)
    else fillRect(x, y, 10, len, 200, 190, 60)
  }
  return { width, height, rgb }
}

export interface HudRect {
  x: number
  y: number
  w: number
  h: number
}

/** Static HUD layout in frame coordinates (fractions of the frame). */
export function hudRects(fw: number, fh: number): HudRect[] {
  return [
    { x: 0, y: 0, w: fw, h: Math.round(fh * 0.07) }, // top bar
    { x: Math.round(fw * 0.84), y: Math.round(fh * 0.15), w: Math.round(fw * 0.14), h: Math.round(fh * 0.55) }, // side panel
    { x: Math.round(fw * 0.25), y: Math.round(fh * 0.88), w: Math.round(fw * 0.5), h: Math.round(fh * 0.12) }, // toolbar
    { x: Math.round(fw * 0.03), y: Math.round(fh * 0.12), w: Math.round(fw * 0.12), h: Math.round(fh * 0.2) }, // minimap
  ]
}

/** Renders a frame: world crop at (cx, cy), HUD on top, lighting applied. */
export function renderFrame(
  world: World,
  cx: number,
  cy: number,
  fw: number,
  fh: number,
  globalGain: number,
  /** Horizontal screen-space shadow gradient strength (cloud edge), 0 = none. */
  shadow: number,
  hudSeed = 7,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(fw * fh * 4)
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const wx = cx + x
      const wy = cy + y
      const o = (y * fw + x) * 4
      const g = globalGain * (1 - shadow * (x / fw))
      if (wx < 0 || wy < 0 || wx >= world.width || wy >= world.height) {
        out[o] = out[o + 1] = out[o + 2] = 20
      } else {
        const i = (wy * world.width + wx) * 3
        out[o] = world.rgb[i] * g
        out[o + 1] = world.rgb[i + 1] * g
        out[o + 2] = world.rgb[i + 2] * g
      }
      out[o + 3] = 255
    }
  }
  // HUD: flat panels with some static "icons/text".
  const rand = mulberry32(hudSeed)
  for (const r of hudRects(fw, fh)) {
    const base = 25 + rand() * 30
    for (let y = r.y; y < Math.min(fh, r.y + r.h); y++) {
      for (let x = r.x; x < Math.min(fw, r.x + r.w); x++) {
        const o = (y * fw + x) * 4
        out[o] = base
        out[o + 1] = base + 5
        out[o + 2] = base + 15
      }
    }
    const icons = Math.round((r.w * r.h) / 900)
    for (let k = 0; k < icons; k++) {
      const ix = r.x + Math.floor(rand() * Math.max(1, r.w - 12))
      const iy = r.y + Math.floor(rand() * Math.max(1, r.h - 12))
      const c = 150 + rand() * 100
      for (let y = iy; y < Math.min(fh, iy + 10); y++) {
        for (let x = ix; x < Math.min(fw, ix + 10); x++) {
          if ((x + y) % 3 === 0) continue
          const o = (y * fw + x) * 4
          out[o] = c
          out[o + 1] = c
          out[o + 2] = c * 0.8
        }
      }
    }
  }
  return out
}

/** Serpentine sweep across the world, like a user panning around. */
export function sweepPath(
  worldW: number,
  worldH: number,
  fw: number,
  fh: number,
  speed: number,
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  const margin = 10
  const maxX = worldW - fw - margin
  const rowStep = Math.round(fh * 0.55)
  let y = margin
  let dir = 1
  let x = margin
  while (y <= worldH - fh - margin) {
    const target = dir > 0 ? maxX : margin
    while ((dir > 0 && x < target) || (dir < 0 && x > target)) {
      pts.push({ x: Math.round(x), y: Math.round(y) })
      x += dir * speed
    }
    x = target
    const ny = y + rowStep
    while (y < ny && y <= worldH - fh - margin) {
      pts.push({ x: Math.round(x), y: Math.round(y) })
      y += speed * 0.7
    }
    dir = -dir
  }
  return pts
}
