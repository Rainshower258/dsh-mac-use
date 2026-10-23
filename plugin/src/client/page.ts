/**
 * The daemon's page on the cu-runtime bundle's detail page: what view.ts decided, drawn with the running dsh's
 * primitives (each checked before use; a plain element when this dsh does not ship it). It reads the status on
 * mount, then every ACTIVE_POLL_MS while an install task runs or another holder has the host's lock (status.busy:
 * an earlier load of the package in this dsh process, or another process) and every IDLE_POLL_MS otherwise, and right
 * after each action, whatever its outcome (after acceptIdentity's refusal too, so a certificate that changed again is
 * what the page then shows); nothing is read after it unmounts. An action's failure is shown until the next action, or until
 * a status read begun ACTION_ERROR_MS or more after it ends: that read's own outcome (the status, or its failure) is
 * then what the page shows, so an old failure neither outlives the state it was about nor hides a newer one.
 *
 * Its 模式检查 section (ModeCheckSection, a component of its own; not in dsh's summary view) reads the host's mode
 * check once when the tab is
 * shown (modeCheck: the host's cached result, or a fresh run) and again on 重新检查 (modeCheckRefresh); it is not
 * polled.
 *
 * @module
 */

import { createElement as h, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, asFailure, post } from './api.ts'
import { BUTTON_BORDER } from './settings/ui.ts'
import { buildModeCheckView, buildView, heldElsewhere, readModeCheck, readStatus, taskActive, type Action, type DotState,
  type Failure, type IdentityChange, type ModeCheckResult, type Op, type Row, type Section, type Status, type TaskView,
  type Translate } from './view.ts'

export const ACTIVE_POLL_MS = 1000
export const IDLE_POLL_MS = 10_000

/** How long an action's failure stays on the page at least (time to read the host's detail). */
export const ACTION_ERROR_MS = 30_000

/** An action's failure, the action, and when it was known (Date.now()). */
interface ActionFailure {
  readonly failure: Failure
  readonly op: Op
  readonly at: number
}

/** The owner props of a `plugins.bundle.config` entry, plus the translate seat its `locale` registration adds. */
export interface PageProps {
  readonly view?: 'summary' | 'page'
  readonly t: Translate
}

const present = (component: unknown): boolean =>
  typeof component === 'function' || (typeof component === 'object' && component !== null)

const STYLE: Record<string, CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, lineHeight: 1.5, minWidth: 0 },
  line: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, minWidth: 0 },
  section: { display: 'grid', gap: 8, minWidth: 0 },
  heading: { margin: 0, fontSize: 13, fontWeight: 600 },
  rows: { display: 'grid', gridTemplateColumns: 'minmax(96px, max-content) minmax(0, 1fr)', columnGap: 16, rowGap: 6, margin: 0 },
  label: { color: 'var(--dsw-alias-label-secondary)' },
  value: { display: 'flex', alignItems: 'center', gap: 6, margin: 0, minWidth: 0, overflowWrap: 'anywhere' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  task: { display: 'grid', gap: 8, padding: 14, border: '.5px solid var(--dsw-alias-border-l1)', borderRadius: 10, minWidth: 0 },
  quiet: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
  warn: { margin: 0, color: 'var(--dsw-alias-state-warn-primary)' },
  error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' },
  log: {
    margin: 0, padding: 8, maxHeight: 200, overflow: 'auto', borderRadius: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-module-platform)',
  },
  modeCheckList: {
    margin: 0, padding: '6px 8px 6px 24px', maxHeight: 160, overflow: 'auto', borderRadius: 6, overflowWrap: 'anywhere',
    fontSize: 12, background: 'var(--dsw-alias-bg-module-platform)',
  },
  button: {
    padding: '4px 12px', borderRadius: 8, border: BUTTON_BORDER,
    background: 'none', color: 'inherit', font: 'inherit',
  },
}

const DOT_COLOR: Record<DotState, string> = {
  done: 'var(--dsw-alias-state-success-primary)',
  warning: 'var(--dsw-alias-state-warn-primary)',
  ongoing: 'var(--dsw-alias-state-business-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
}

function dot(state: DotState): ReactNode {
  const { StateDot } = primitives
  if (present(StateDot)) return h(StateDot!, { state })
  return h('span', { 'aria-hidden': true, 'data-state': state,
    style: { flex: 'none', width: 8, height: 8, borderRadius: '50%', background: DOT_COLOR[state] } })
}

function tag(text: string): ReactNode {
  const { Tag } = primitives
  return present(Tag) ? h(Tag!, { tone: 'neutral' }, text) : h('span', null, text)
}

function button(action: Action, run: (op: Op) => void): ReactNode {
  const { Button } = primitives
  const props = { key: action.op, disabled: !action.enabled, onClick: () => run(action.op) }
  return present(Button)
    ? h(Button!, { ...props, variant: action.variant, size: 'sm',
      ...(action.variant === 'primary' ? {} : { style: { border: BUTTON_BORDER } }) }, action.label)
    : h('button', { ...props, type: 'button', style: { ...STYLE.button, opacity: action.enabled ? 1 : 0.5 } }, action.label)
}

/** The rows whose value is a certificate's SHA-1. */
const SHA1_ROWS: ReadonlySet<string> = new Set(['identitySha1', 'identityKnown'])

/**
 * A version is drawn as a tag, a certificate's SHA-1 (in openssl's form, to compare with `openssl x509 -fingerprint
 * -sha1` of the backed-up certificate) in a monospace font; `none` is the placeholder text, drawn plain.
 */
function row(r: Row, none: string): ReactNode[] {
  const value = r.value === none ? h('span', null, r.value)
    : r.id === 'version' || r.id === 'pluginVersion' ? tag(r.value)
      : SHA1_ROWS.has(r.id) ? h('code', { style: STYLE.code }, r.value)
        : h('span', null, r.value)
  return [
    h('dt', { key: `${r.id}:label`, style: STYLE.label }, r.label),
    h('dd', { key: `${r.id}:value`, style: STYLE.value }, r.state === null ? null : dot(r.state), value),
  ]
}

function section(s: Section, none: string): ReactNode {
  return h('section', { key: s.id, style: STYLE.section },
    h('h4', { style: STYLE.heading }, s.title),
    h('dl', { style: STYLE.rows }, ...s.rows.flatMap((r) => row(r, none))))
}

/**
 * A changed identity: what to check before accepting it, and the commands that read a backed-up certificate's SHA-1
 * (each on its own line of the section's grid).
 */
function identityChange(view: IdentityChange): ReactNode {
  return h('section', { style: STYLE.task, 'data-cu-runtime-identity': '' },
    h('p', { style: STYLE.warn }, view.text),
    ...view.commands.map((command) => h('code', { key: command, style: STYLE.code }, command)))
}

function task(view: TaskView): ReactNode {
  return h('section', { style: STYLE.task, 'aria-live': 'polite' },
    h('p', { style: { ...STYLE.line, fontWeight: 600 } }, dot(view.state), h('span', null, view.title)),
    view.step === null ? null : h('p', { style: STYLE.quiet }, view.step),
    view.keychain === null ? null : h('p', { style: STYLE.warn }, view.keychain),
    view.note === null ? null : h('p', { style: STYLE.quiet }, view.note),
    view.error === null ? null : h('p', { style: STYLE.error }, view.error.text),
    view.error?.detail == null ? null : h('p', { style: STYLE.error }, view.error.detail),
    view.openDialog === null ? null : h('p', { style: STYLE.warn }, view.openDialog),
    view.log.length === 0 ? null : h('p', { style: STYLE.quiet }, view.logTitle),
    view.log.length === 0 ? null : h('pre', { style: STYLE.log }, view.log.join('\n')))
}

/** A non-primary button of the page (the 1px border), outside the actions' row. */
function plainButton(key: string, label: string, enabled: boolean, onClick: () => void): ReactNode {
  const { Button } = primitives
  const props = { key, disabled: !enabled, onClick }
  // dsh's outline is .5px of a faint color: the page's own 1px border, as button() gives its non-primary buttons.
  const border = { style: { border: BUTTON_BORDER } }
  return present(Button)
    ? h(Button!, { ...props, variant: 'outline', size: 'sm', ...border }, label)
    : h('button', { ...props, type: 'button', style: { ...STYLE.button, opacity: enabled ? 1 : 0.5 } }, label)
}

/**
 * The 模式检查 section: its own state (the last result, a read in flight, the last read's failure); the host's cached
 * result read on mount, a fresh run on 重新检查; nothing is set after it unmounts.
 */
export function ModeCheckSection({ t }: { readonly t: Translate }): ReactNode {
  const [result, setResult] = useState<ModeCheckResult | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<Failure | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let stopped = false
    setPending(true)
    post(round === 0 ? 'modeCheck' : 'modeCheckRefresh').then((body) => {
      if (stopped) return
      setResult(readModeCheck(body))
      setError(null)
    }).catch((e: unknown) => {
      if (!stopped) setError(asFailure(e))
    }).finally(() => {
      if (!stopped) setPending(false)
    })
    return () => { stopped = true }
  }, [round])

  const view = buildModeCheckView(result, { t, pending, error })
  return h('section', { style: STYLE.section, 'data-cu-runtime-mode-check': '' },
    h('h4', { style: STYLE.heading }, view.title),
    h('p', { style: STYLE.quiet }, view.about),
    h('p', { style: STYLE.line, role: 'status' }, dot(view.state), h('span', null, view.text)),
    view.lines.length === 0 ? null
      : h('ul', { style: STYLE.modeCheckList }, ...view.lines.map((line, i) => h('li', { key: String(i) }, line))),
    view.checkedAt === null ? null : h('p', { style: STYLE.quiet }, view.checkedAt),
    view.error === null ? null : h('div', { role: 'alert' },
      h('p', { style: STYLE.error }, view.error.text),
      view.error.detail === null ? null : h('p', { style: STYLE.error }, view.error.detail)),
    h('div', { style: STYLE.actions },
      plainButton('modeCheckRefresh', view.refresh.label, view.refresh.enabled, () => setRound((n) => n + 1))))
}

/**
 * The page. Its own state: the last status read and its failure, the action in flight, and the last action's
 * outcome (its failure until a later status read settles it, see the module); everything shown is buildView's.
 */
export function Page({ t, view: shownAs }: PageProps): ReactNode {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<Failure | null>(null)
  const [pending, setPending] = useState<Op | null>(null)
  const [done, setDone] = useState<Op | null>(null)
  const [actionError, setActionError] = useState<ActionFailure | null>(null)
  // Bumped after each action: the poll restarts with an immediate read (and 1 s polling once a task, or another
  // holder of the host's lock, shows up).
  const [round, setRound] = useState(0)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = false
    const controller = new AbortController()
    const poll = async (): Promise<void> => {
      const began = Date.now()
      // A read begun ACTION_ERROR_MS or more after an action's failure replaces it; the read right after the action
      // does not.
      const settle = (): void =>
        setActionError((shown) => shown !== null && began - shown.at >= ACTION_ERROR_MS ? null : shown)
      try {
        const next = readStatus(await post('status', controller.signal))
        if (stopped) return
        active = taskActive(next.task) || heldElsewhere(next)
        setStatus(next)
        setStatusError(null)
        settle()
      } catch (error) {
        if (stopped) return
        setStatusError(asFailure(error))
        settle()
      }
      timer = setTimeout(() => void poll(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [round])

  const run = useCallback((op: Op): void => {
    setPending(op)
    setDone(null)
    setActionError(null)
    act(op).then(
      () => setDone(op),
      (error: unknown) => setActionError({ failure: asFailure(error), op, at: Date.now() }),
    ).finally(() => {
      setPending(null)
      setRound((n) => n + 1)
    })
  }, [])

  const view = buildView(status, {
    t, pending, done, actionError: actionError?.failure ?? null, actionErrorOp: actionError?.op ?? null, statusError,
  })
  return h('div', { style: STYLE.page, 'data-cu-runtime-page': '' },
    h('p', { style: STYLE.line, role: 'status' }, dot(view.summary.state), h('span', null, view.summary.text)),
    view.error === null ? null : h('div', { role: 'alert' },
      h('p', { style: STYLE.error }, view.error.text),
      view.error.detail === null ? null : h('p', { style: STYLE.error }, view.error.detail)),
    ...view.sections.map((s) => section(s, t('value.none'))),
    view.identityChange === null ? null : identityChange(view.identityChange),
    view.actions.length === 0 ? null : h('div', { style: STYLE.actions }, ...view.actions.map((a) => button(a, run))),
    view.permissionsHint === null ? null : h('p', { style: STYLE.quiet }, view.permissionsHint),
    view.notice === null ? null : h('p', { style: STYLE.quiet }, view.notice),
    view.task === null ? null : task(view.task),
    // A component of its own (its hooks are its own): read when the tab is shown, not with the status poll; not in
    // dsh's summary view, which is the daemon's state alone.
    shownAs === 'summary' ? null : h(ModeCheckSection, { t }),
    h('p', { style: STYLE.quiet }, view.pluginUpdateHint))
}
