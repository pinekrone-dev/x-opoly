import { Component, type ReactNode } from 'react'

/**
 * The last line before a white page.
 *
 * React takes the whole screen down when a component throws while drawing,
 * and without this there was nothing left to click. It says so plainly and
 * offers the one thing that helps.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Land Quotient stopped drawing this page', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-white p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-slate-900">This page stopped loading</h1>
          <p className="mt-2 text-sm text-slate-600">
            Your work is saved. Reloading usually brings the page back.
          </p>
          <button
            type="button"
            className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
