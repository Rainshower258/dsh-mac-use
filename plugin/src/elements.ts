/**
 * Stable element ids and diffs (PLAN-v2 R4). The daemon's element ids (a1, o7) are valid only in the snapshot they
 * came from. The model gets ids derived from each element's key (a hash of role, identifier, text, frame, window,
 * source), which stay the same across observes while the element is unchanged; the plugin maps them to the latest
 * snapshot's id and generation. That lets observe send only what changed after the first call. A changed element
 * gets a new id, so an old id can never silently point at something different: it is simply unknown.
 *
 * @module
 */

export interface DaemonElement {
  id: string
  key: string
  source: 'ax' | 'ocr'
  text: string
  frame_pt: [number, number, number, number] | null
  occluded: boolean
  role?: string
  app?: string
  confidence?: number
  intercepted_by?: string
}

export interface Resolved {
  daemonId: string
  gen: number
}

export interface Diff {
  full: boolean
  shown: Array<DaemonElement & { sid: string }>
  removed: string[]
  unchanged: number
}

export class ElementBook {
  private current = new Map<string, DaemonElement & { sid: string }>()
  private gen = -1

  /** Takes a new snapshot; returns what to show: everything (first call or `full`) or the changes. */
  update(elements: DaemonElement[], gen: number, full: boolean): Diff {
    const first = this.gen < 0
    const prev = this.current
    const next = new Map<string, DaemonElement & { sid: string }>()
    for (const e of elements) {
      let sid = (e.source === 'ocr' ? 'o' : 'e') + e.key.slice(0, 7)
      for (let n = 8; next.has(sid) && n <= e.key.length; n++) sid = (e.source === 'ocr' ? 'o' : 'e') + e.key.slice(0, n)
      if (next.has(sid)) continue   // identical key twice (same element reported twice): keep the first
      next.set(sid, { ...e, sid })
    }
    this.current = next
    this.gen = gen
    if (first || full) return { full: true, shown: [...next.values()], removed: [], unchanged: 0 }
    const shown = [...next.values()].filter((e) => !prev.has(e.sid))
    const removed = [...prev.keys()].filter((sid) => !next.has(sid))
    return { full: false, shown, removed, unchanged: next.size - shown.length }
  }

  /** The latest snapshot's daemon id and generation for a stable id, or undefined if it is not on screen now. */
  resolve(sid: string): Resolved | undefined {
    const e = this.current.get(sid)
    return e === undefined ? undefined : { daemonId: e.id, gen: this.gen }
  }

  get latestGen(): number | undefined { return this.gen < 0 ? undefined : this.gen }
  get size(): number { return this.current.size }
}

/** One line per element for the model. */
export function renderElement(e: DaemonElement & { sid: string }): string {
  const f = e.frame_pt === null ? '(no frame)' : `@${e.frame_pt.map((v) => Math.round(v)).join(',')}`
  const flags = [
    e.source === 'ocr' ? `ocr${e.confidence === undefined ? '' : ` ${e.confidence.toFixed(2)}`}` : e.role ?? 'ax',
    e.occluded ? 'occluded' : undefined,
    e.intercepted_by === undefined ? undefined : `clicks here go to ${e.intercepted_by}`,
  ].filter((x) => x !== undefined).join(', ')
  return `${e.sid} ${JSON.stringify(e.text)} ${f} [${flags}]`
}
