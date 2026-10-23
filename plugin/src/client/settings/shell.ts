/**
 * The plugin page's tab shell: a tab bar over one panel. 守护进程 (the daemon tab) is the daemon page as it was
 * before the tabs (page.ts, unchanged) and the default; the seven settings tabs follow in the native window's order
 * (model.ts SETTINGS_TABS). dsh's summary view gets the daemon page alone, as before.
 *
 * The settings tabs share one SettingsPage, mounted only while one of them is shown, so the snapshot is read only
 * then: on mount, every SETTINGS_ACTIVE_POLL_MS while a change waits for the owner check or a panel is open on the Mac,
 * else every SETTINGS_IDLE_POLL_MS, and at once after every apply, action and cancel, whatever its outcome; nothing is
 * read after it unmounts (the read in flight is aborted). Above the shown tab it draws, in this order: the reading
 * line before the first snapshot; the pending banner (what waits, in words; that Touch ID or the login password is
 * asked on the Mac; 取消, which posts settings.cancelVerify); the last settled outcome, once (model.ts outcomeNotice);
 * the last request's answer; the last request's failure and the last read's (not_running with a link to the daemon
 * tab). While a change waits, a request is in flight, no snapshot is there or none read after the last request has
 * come back yet (the one shown predates it: a change the request left waiting is not in it), the tab's `pending` is
 * true and every control that changes something is disabled. A request's failure and answer stay until the next request; a failed
 * read keeps the last snapshot, except not_running and busy, after which nothing the old snapshot said holds.
 *
 * @module
 */

import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Page, type PageProps } from '../page.ts'
import type { Translate } from '../view.ts'
import { applyChange, asSettingsFailure, cancelVerify, fetchSnapshot, runAction } from './api.ts'
import type { SettingsAction, SettingsChange } from './change.ts'
import { PAGE_TABS, SETTINGS_IDLE_POLL_MS, outcomeNotice, pollDelay, resultText, settingsErrorMessage, summaryText,
  type PageTab, type RouteResult, type SettingsFailure, type SettingsTab, type Snapshot } from './model.ts'
import type { Kit, TabModule, TabProps } from './tab.ts'
import { TAB_MODULES } from './tabs/index.ts'
import { STYLES, button, dot, makeKit, tabBar, tabPanelId } from './ui.ts'

/** Read failures after which the last snapshot is dropped: the daemon is gone or being replaced. */
const DROPS_SNAPSHOT: ReadonlySet<string> = new Set(['not_running', 'busy'])

/**
 * The page dsh mounts in `plugins.bundle.config`: the tab bar (SegmentedTabs when the running dsh has it) and the
 * shown tab's panel, 守护进程 first.
 */
export function PluginPage(props: PageProps): ReactNode {
  const [tab, setTab] = useState<PageTab>('daemon')
  if (props.view === 'summary') return h(Page, props)
  const { t } = props
  return h('div', { style: { ...STYLES.tab, fontSize: 13, lineHeight: 1.5 }, 'data-cu-runtime-plugin-page': '' },
    tabBar({
      label: t('settings.tabs.label'), value: tab, onChange: (value) => setTab(value as PageTab),
      items: PAGE_TABS.map((id) => ({ value: id, label: t(`settings.tab.${id}`) })),
    }),
    h('div', { role: 'tabpanel', id: tabPanelId(tab), 'aria-labelledby': `cu-runtime-tab-${tab}`, 'data-cu-runtime-tab-panel': tab },
      tab === 'daemon' ? h(Page, props) : h(SettingsPage, { t, tab, goTo: setTab })))
}

interface SettingsPageProps {
  readonly t: Translate
  readonly tab: SettingsTab
  readonly goTo: (tab: PageTab) => void
}

interface TabHostProps {
  readonly module: TabModule
  readonly props: TabProps
  readonly ui: Kit
}

/** The shown tab's render as a component of its own (keyed by the tab), so the tab's hooks are its own. */
function TabHost({ module, props, ui }: TabHostProps): ReactNode {
  return module.render(props, ui)
}

function failureBlock(t: Translate, failure: SettingsFailure, now: number, goTo: (tab: PageTab) => void, key: string): ReactNode {
  const message = settingsErrorMessage(t, failure, now)
  return h('div', { key, role: 'alert', style: { display: 'grid', gap: 4 }, 'data-cu-runtime-error': failure.code },
    h('p', { style: STYLES.error }, message.text),
    message.detail === null ? null : h('p', { style: STYLES.error }, message.detail),
    message.toDaemon ? h('div', { style: STYLES.actions }, button({ key: 'toDaemon', label: t('settings.toDaemon'), onClick: () => goTo('daemon') })) : null)
}

/** The settings tabs' model and frame; see the module. */
function SettingsPage({ t, tab, goTo }: SettingsPageProps): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [readError, setReadError] = useState<SettingsFailure | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [requestError, setRequestError] = useState<SettingsFailure | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [since] = useState(() => Date.now())
  // Bumped after each request: the poll restarts with an immediate read.
  const [round, setRound] = useState(0)
  // The round the shown snapshot was read in: behind `round` until the read after the last request has come back.
  const [readRound, setReadRound] = useState(0)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const poll = async (): Promise<void> => {
      let delay = SETTINGS_IDLE_POLL_MS
      try {
        const next = await fetchSnapshot(controller.signal)
        if (stopped) return
        setSnapshot(next)
        setReadRound(round)
        setReadError(null)
        delay = pollDelay(next)
      } catch (error) {
        if (stopped) return
        const failure = asSettingsFailure(error)
        setReadError(failure)
        if (DROPS_SNAPSHOT.has(failure.code)) setSnapshot(null)
      }
      timer = setTimeout(() => void poll(), delay)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [round])

  /** One request: its answer or failure replaces the last one's; the snapshot is read again after it either way. */
  const send = useCallback(async (what: string, request: () => Promise<RouteResult>): Promise<boolean> => {
    setInFlight(true)
    setRequestError(null)
    setAnswer(null)
    try {
      setAnswer(resultText(t, what, await request()))
      return true
    } catch (error) {
      setRequestError(asSettingsFailure(error))
      return false
    } finally {
      setInFlight(false)
      setRound((n) => n + 1)
    }
  }, [t])
  const apply = useCallback((change: SettingsChange) => send(change.kind, () => applyChange(change)), [send])
  const action = useCallback((name: SettingsAction) => send(name, () => runAction(name)), [send])

  const now = Date.now()
  const pending = snapshot === null || snapshot.pending !== null || inFlight || readRound !== round
  const notice = outcomeNotice(t, snapshot?.last_outcome ?? null, since, dismissed)
  const props: TabProps = { snapshot, t, pending, apply, action, goTo, now }
  return h('div', { style: STYLES.tab, 'data-cu-runtime-settings': tab },
    snapshot === null && readError === null ? h('p', { role: 'status', style: STYLES.quiet }, t('settings.loading')) : null,
    snapshot?.pending == null ? null : h('section', {
      role: 'status', 'aria-live': 'polite', 'data-cu-runtime-pending': snapshot.pending.kind,
      style: { ...STYLES.card, borderColor: 'var(--dsw-alias-state-warn-primary)' },
    },
    h('p', { style: { ...STYLES.line, fontWeight: 600 } }, dot('ongoing'),
      h('span', null, t('settings.pending.title', { summary: summaryText(t, snapshot.pending, snapshot) }))),
    h('p', { style: STYLES.warn }, t('settings.pending.verify')),
    h('p', { style: STYLES.quiet }, t('settings.pending.locked')),
    h('div', { style: STYLES.actions },
      button({ key: 'cancelVerify', label: t('settings.pending.cancel'), disabled: inFlight,
        onClick: () => void send('cancel', cancelVerify) }))),
    notice === null ? null : h('div', { role: 'status', style: STYLES.line, 'data-cu-runtime-outcome': notice.key },
      dot(notice.state), h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, notice.text),
      button({ key: 'dismiss', label: t('settings.notice.dismiss'), onClick: () => setDismissed(notice.key), variant: 'ghost' })),
    answer === null ? null : h('p', { role: 'status', style: STYLES.quiet, 'data-cu-runtime-answer': '' }, answer),
    requestError === null ? null : failureBlock(t, requestError, now, goTo, 'requestError'),
    readError === null || readError.code === requestError?.code ? null : failureBlock(t, readError, now, goTo, 'readError'),
    h(TabHost, { key: tab, module: TAB_MODULES[tab], props, ui: makeKit(t) }))
}
