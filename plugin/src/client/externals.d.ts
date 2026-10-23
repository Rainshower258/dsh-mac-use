/**
 * The parts of the dsh web client's shared packages the page uses, declared here instead of installing their types
 * (no new npm dependencies). At run time they come from the loader's require (scripts/build-client.mjs EXTERNALS):
 * the host page's React 18 and the primitives of the running dsh.
 */

declare module 'react' {
  export type Key = string | number

  export interface ReactElement {
    readonly type: unknown
    readonly props: unknown
    readonly key: Key | null
  }

  export type ReactNode = ReactElement | string | number | boolean | null | undefined | readonly ReactNode[]

  /** A function component; forwardRef and memo components are objects, which the primitives' exports may be. */
  export type ComponentType<P> = ((props: P) => ReactNode) | { readonly $$typeof: symbol }

  export type CSSProperties = Readonly<Record<string, string | number>>

  export function createElement<P>(type: ComponentType<P>, props: P & { key?: Key }, ...children: ReactNode[]): ReactElement
  export function createElement(type: string, props?: Readonly<Record<string, unknown>> | null, ...children: ReactNode[]): ReactElement

  export type SetState<S> = (next: S | ((previous: S) => S)) => void
  export function useState<S>(initial: S | (() => S)): [S, SetState<S>]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useCallback<F extends (...args: never[]) => unknown>(callback: F, deps: readonly unknown[]): F
}

/**
 * Only what dsh 0.2.1-rc.2 ships. Each export is typed as possibly absent: the primitives differ between 0.2.x
 * releases, so the page checks each one before use and falls back to a plain element.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export const Button: ComponentType<{
    variant?: 'primary' | 'outline' | 'ghost'
    size?: 'sm' | 'md'
    disabled?: boolean
    onClick?: () => void
    children?: ReactNode
  }> | undefined

  export const StateDot: ComponentType<{ state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle' }> | undefined

  export const Tag: ComponentType<{
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    children?: ReactNode
  }> | undefined

  // The rest serve the settings tabs: settings/ui.ts wraps each one with its plain-element fallback, and the tabs use
  // only those wrappers. The props are the subset the page passes.

  /** Controlled equal-width tabs; `id` and `panelId` tie each tab to its panel, which the caller draws. */
  export const SegmentedTabs: ComponentType<{
    items: readonly { value: string; label: ReactNode; id: string; panelId: string }[]
    value: string
    onChange: (value: string) => void
    label: string
  }> | undefined

  /** A controlled choice among a few values. */
  export const SegmentedControl: ComponentType<{
    id: string
    value: string
    options: readonly { value: string; label: string; disabled?: boolean; title?: string }[]
    onChange: (next: string) => void
    label: string
    disabled?: boolean
  }> | undefined

  export const Switch: ComponentType<{
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
  }> | undefined

  /** A native input in dsh's frame; the input attributes pass through. */
  export const Input: ComponentType<{
    value?: string
    onChange?: (event: { readonly target: { readonly value: string } }) => void
    placeholder?: string
    disabled?: boolean
    maxLength?: number
    'aria-label'?: string
  }> | undefined

  /** A dialog portaled to the body; nothing while `open` is false. */
  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    title: string
    closeLabel: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
  }> | undefined

  export const DisclosureRow: ComponentType<{
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    children?: ReactNode
  }> | undefined

  /** Key caps for a shortcut, one per key name. */
  export const ShortcutKeys: ComponentType<{ keys: readonly string[] }> | undefined

  /** A transient notice; onDone once it has faded. */
  export const Toast: ComponentType<{ text: string; tone?: 'success'; onDone: () => void }> | undefined
}
