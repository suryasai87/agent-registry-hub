// Page-state building blocks shared by every page this module owns: an inline error card with retry, content-
// shaped skeletons, and write helpers that turn ApiError statuses into plain-language toasts.
import { RotateCcw, TriangleAlert } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { ApiError } from "../../lib/api";
import { cx } from "../../lib/cx";
import { Button, Card, Skeleton, useToast } from "../ui";

/** Human phrasing for a failed write (403 / 409 / 503 get their own wording; the backend detail is kept). */
export function writeErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = err.detail || `HTTP ${err.status}`;
    switch (err.status) {
      case 400:
      case 422:
        return detail;
      case 403:
        return `Your role doesn't allow this. ${detail}`;
      case 404:
        return `It no longer exists. ${detail}`;
      case 409:
        return `It changed state in the meantime. ${detail}`;
      case 503:
        return `Changes are unavailable right now (read-only mode or Lakebase is down). ${detail}`;
      default:
        return detail;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** Read errors: a friendlier one-liner for the inline card. */
export function readErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return `You don't have access to this view. ${err.detail}`;
    if (err.status === 404) return `The backend doesn't serve this yet. ${err.detail}`;
    return err.detail || `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function ErrorCard({ error, onRetry, title = "Couldn't load this", className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <Card role="alert" className={cx("flex items-start gap-3 border-destructive/40", className)}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive">
        <TriangleAlert size={18} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-ui-md font-bold">{title}</div>
        <p className="mt-0.5 break-words text-ui-sm text-muted-foreground">{readErrorText(error)}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" icon={<RotateCcw size={13} aria-hidden />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </Card>
  );
}

export function RowsSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cx("space-y-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cx("grid gap-4 md:grid-cols-2 xl:grid-cols-3", className)}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="space-y-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-16 w-full" />
        </Card>
      ))}
    </div>
  );
}

export function KpiSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="space-y-2 !p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16" />
        </Card>
      ))}
    </div>
  );
}

/**
 * Loading / error / empty / ready for one useApi() result. Data already on screen stays while a reload runs;
 * an error with data keeps the data and shows nothing extra (the next write or retry will surface it).
 */
export function AsyncBlock<T>({
  state,
  skeleton,
  empty,
  isEmpty,
  errorTitle,
  children,
}: {
  state: { data: T | null; loading: boolean; error: unknown; reload: () => void };
  skeleton?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  errorTitle?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.data === null) {
    if (state.error) return <ErrorCard error={state.error} onRetry={state.reload} title={errorTitle} />;
    return <>{skeleton ?? <RowsSkeleton />}</>;
  }
  if (empty !== undefined && isEmpty?.(state.data)) return <>{empty}</>;
  return <>{children(state.data)}</>;
}

/**
 * Run a write with a pending flag and a toast on failure (and optionally on success). Returns the result, or
 * undefined when the write failed (the toast already explained why). ``key`` lets several buttons share it.
 */
export function useWrite() {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    async <R,>(key: string, failTitle: string, fn: () => Promise<R>, success?: string | ((r: R) => string | null)): Promise<R | undefined> => {
      setPending(key);
      try {
        const result = await fn();
        const msg = typeof success === "function" ? success(result) : success;
        if (msg) toast.success(msg);
        return result;
      } catch (err) {
        toast.error(failTitle, writeErrorText(err));
        return undefined;
      } finally {
        setPending((p) => (p === key ? null : p));
      }
    },
    [toast],
  );
  return { run, pending, isPending: (key: string) => pending === key };
}

/** Visually hidden live region (polite) for async announcements. */
export function LiveRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div aria-live="polite" role="status" className={cx("sr-only", className)}>
      {children}
    </div>
  );
}
