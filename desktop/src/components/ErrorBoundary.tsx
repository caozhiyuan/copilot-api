import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { primaryButtonClass } from '../lib/button-styles'

export interface ErrorBoundaryLabels {
  title: string
  description: string
  retry: string
  reload: string
}

export interface ErrorBoundaryProps {
  children: ReactNode
  labels?: ErrorBoundaryLabels
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  onReload?: () => void
  onReset?: () => void
}

interface ErrorBoundaryState {
  error: Error | null
}

const DEFAULT_LABELS: ErrorBoundaryLabels = {
  title: 'Something went wrong',
  description:
    'An unexpected error occurred while rendering this view. You can try again or reload the window.',
  retry: 'Try again',
  reload: 'Reload window',
}

function reloadWindow(): void {
  if (typeof window === 'undefined') return
  if (typeof window.electronAPI?.windowReload === 'function') {
    window.electronAPI.windowReload()
    return
  }
  window.location.reload()
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, errorInfo)
      return
    }
    console.error('Unhandled render error:', error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  handleReload = (): void => {
    if (this.props.onReload) {
      this.props.onReload()
      return
    }
    reloadWindow()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const labels = this.props.labels ?? DEFAULT_LABELS

    return (
      <div
        role="alert"
        className="flex min-h-screen items-center justify-center bg-canvas px-6 text-ink"
      >
        <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-base font-semibold text-ink">{labels.title}</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            {labels.description}
          </p>
          {error.message && (
            <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-line-soft bg-sunken px-3 py-2 font-mono text-xs text-red-600 dark:text-red-400">
              {error.message}
            </pre>
          )}
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
            >
              {labels.retry}
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className={`px-3 py-1.5 text-[13px] font-medium ${primaryButtonClass}`}
            >
              {labels.reload}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export function AppErrorBoundary({
  children,
  onError,
  onReload,
  onReset,
}: Omit<ErrorBoundaryProps, 'labels'>) {
  const { t } = useLanguage()

  return (
    <ErrorBoundary
      labels={{
        title: t('errorBoundary.title'),
        description: t('errorBoundary.description'),
        retry: t('errorBoundary.retry'),
        reload: t('errorBoundary.reload'),
      }}
      onError={onError}
      onReload={onReload}
      onReset={onReset}
    >
      {children}
    </ErrorBoundary>
  )
}
