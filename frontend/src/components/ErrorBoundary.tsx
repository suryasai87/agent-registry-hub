// Contains render errors: a throwing page shows a friendly card with retry instead of blanking the app.
// Mount one at the root (fullPage) and one per route (resetKey = pathname, so navigating away recovers).
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  name?: string;
  resetKey?: unknown;
  fullPage?: boolean;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name ?? "app"}] render error`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const where = this.props.name ? `“${this.props.name}”` : "this view";
    return (
      <div className={this.props.fullPage ? "grid min-h-screen place-items-center bg-background p-6 text-foreground" : "py-6"}>
        <div role="alert" className="mx-auto w-full max-w-xl rounded-xl border border-warning/40 bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
              <TriangleAlert size={18} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-ui-md font-bold">Something went wrong in {where}</h2>
              <p className="mt-1 text-ui-sm text-muted-foreground">The problem was contained; the rest of the app keeps working.</p>
              <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-ui-xs text-muted-foreground">{error.message || error.name}</pre>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={this.reset} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm font-semibold text-primary-foreground hover:brightness-110">
                  <RotateCcw size={14} aria-hidden />
                  Try again
                </button>
                <button type="button" onClick={() => window.location.reload()} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
                  Reload page
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
