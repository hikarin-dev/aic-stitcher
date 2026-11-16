/**
 * Minimum cut (maximum flow, Dinic's algorithm) on a graph whose nodes have up to four
 * neighbours, as cells of a grid do. Used to decide which of two overlapping pictures
 * each cell of the overlap is taken from, so that the border between them is as
 * inconspicuous as possible (see Mosaic.assemble).
 *
 * Every node ends up on the source side or the sink side. The cost that is minimised:
 *   - `capS[p]` if p ends up on the sink side,
 *   - `capT[p]` if p ends up on the source side,
 *   - the capacity of every link between a source-side and a sink-side node.
 * Capacities are non-negative integers.
 */
export class MinCut {
  /** Nodes in use (see reset). */
  n = 0
  capS = new Int32Array(0)
  capT = new Int32Array(0)
  /** nbr[4p + d]: neighbour of node p in direction d (0 right, 1 left, 2 down, 3 up), −1 = none. */
  nbr = new Int32Array(0)
  /** Remaining capacity of the link from p in direction d. */
  cap = new Int32Array(0)
  private level = new Int32Array(0)
  private queue = new Int32Array(0)
  private arc = new Uint8Array(0)
  private pathN = new Int32Array(0)
  private pathE = new Int32Array(0)

  /** Starts a new problem with `n` unconnected nodes. */
  reset(n: number): void {
    if (this.capS.length < n) {
      const size = Math.ceil(n * 1.25) + 16
      this.capS = new Int32Array(size)
      this.capT = new Int32Array(size)
      this.nbr = new Int32Array(size * 4)
      this.cap = new Int32Array(size * 4)
      this.level = new Int32Array(size)
      this.queue = new Int32Array(size)
      this.arc = new Uint8Array(size)
      this.pathN = new Int32Array(size + 1)
      this.pathE = new Int32Array(size + 1)
    }
    this.n = n
    this.capS.fill(0, 0, n)
    this.capT.fill(0, 0, n)
    this.nbr.fill(-1, 0, n * 4)
    this.cap.fill(0, 0, n * 4)
  }

  /** Links p to q, which lies in direction `d` of p (0 right, 2 down), with capacity `w` both ways. */
  link(p: number, q: number, d: 0 | 2, w: number): void {
    this.nbr[p * 4 + d] = q
    this.cap[p * 4 + d] = w
    this.nbr[q * 4 + d + 1] = p
    this.cap[q * 4 + d + 1] = w
  }

  /** Whether node p is on the source side. Valid after solve(). */
  onSourceSide(p: number): boolean {
    return this.level[p] > 0
  }

  /** @returns the cost of the minimum cut */
  solve(): number {
    const { n, capS, capT, nbr, cap, level, queue, arc, pathN, pathE } = this
    let flow = 0
    // What can go straight from the source through a node to the sink does.
    for (let p = 0; p < n; p++) {
      const f = capS[p] < capT[p] ? capS[p] : capT[p]
      if (f > 0) {
        capS[p] -= f
        capT[p] -= f
        flow += f
      }
    }
    for (;;) {
      // Distance of every node from the source, along links with capacity left.
      level.fill(0, 0, n)
      let head = 0
      let tail = 0
      for (let p = 0; p < n; p++) {
        if (capS[p] > 0) {
          level[p] = 1
          queue[tail++] = p
        }
      }
      const sources = tail
      let sinkReached = false
      while (head < tail) {
        const p = queue[head++]
        if (capT[p] > 0) sinkReached = true
        const next = level[p] + 1
        for (let e = p * 4; e < p * 4 + 4; e++) {
          const q = nbr[e]
          if (q >= 0 && cap[e] > 0 && level[q] === 0) {
            level[q] = next
            queue[tail++] = q
          }
        }
      }
      // No way left from source to sink: `level` now marks the source side.
      if (!sinkReached) return flow

      // Push flow along shortest paths until none is left (a blocking flow).
      arc.fill(0, 0, n)
      for (let k = 0; k < sources; k++) {
        const s = queue[k]
        while (capS[s] > 0) {
          let depth = 0
          pathN[0] = s
          let pushed = 0
          for (;;) {
            const p = pathN[depth]
            if (capT[p] > 0) {
              let f = capS[s] < capT[p] ? capS[s] : capT[p]
              for (let i = 0; i < depth; i++) if (cap[pathE[i]] < f) f = cap[pathE[i]]
              capS[s] -= f
              capT[p] -= f
              for (let i = 0; i < depth; i++) {
                const e = pathE[i]
                cap[e] -= f
                // The opposite direction of the same link, seen from the other end.
                cap[nbr[e] * 4 + ((e & 3) ^ 1)] += f
              }
              pushed = f
              break
            }
            let advanced = false
            const next = level[p] + 1
            while (arc[p] < 4) {
              const e = p * 4 + arc[p]
              const q = nbr[e]
              if (q >= 0 && cap[e] > 0 && level[q] === next) {
                pathE[depth] = e
                pathN[++depth] = q
                advanced = true
                break
              }
              arc[p]++
            }
            if (advanced) continue
            // Dead end: nothing reaches the sink from here in this round.
            level[p] = -1
            if (depth === 0) break
            depth--
          }
          if (pushed === 0) break
          flow += pushed
        }
      }
    }
  }
}
