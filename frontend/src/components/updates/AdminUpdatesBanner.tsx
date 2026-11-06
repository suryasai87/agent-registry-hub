// The admin banner under the navbar: "N platform updates are ready for your decision (M breaking) · Review".
// Only for real admins (not while previewing a lower role). It fetches GET /api/platform-watch once per session,
// again on window focus at most every 5 min, and when you leave the Platform updates page. Any error (403, 404,
// network) hides it: the shell never breaks. Dismissal is kept in sessionStorage against the counts, so it
// comes back when they change.
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCcwDot, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../../lib/api";
import type { Session } from "../../lib/session";
import type { UpdateCandidate, WatchOverview } from "../../lib/types";
import { bannerCounts, bannerSignature, bannerText, bannerVisible, type BannerCounts } from "./model";

export const BANNER_DISMISS_KEY = "arh.platformUpdatesBanner.dismissed";
export const BANNER_REFRESH_MS = 5 * 60_000;
const PAGE = "/platform-updates";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(BANNER_DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string): void {
  try {
    window.sessionStorage.setItem(BANNER_DISMISS_KEY, value);
  } catch {
    /* storage unavailable: the dismissal lasts until the next render only */
  }
}

/** Overview + (when anything is ready) the passed candidates for the breaking count; null on any failure. */
export async function loadBannerCounts(signal?: AbortSignal): Promise<BannerCounts | null> {
  try {
    const overview = (await api.get<WatchOverview>("/api/platform-watch", { signal })).data;
    if (!overview || typeof overview.ready !== "number") return null;
    let passed: UpdateCandidate[] | null = null;
    if (overview.ready > 0) {
      passed = await api.get<UpdateCandidate[]>("/api/platform-watch/candidates?status=passed", { signal }).then(
        (env) => (Array.isArray(env.data) ? env.data : null),
        () => null,
      );
    }
    return bannerCounts(overview, passed);
  } catch {
    return null;
  }
}

export default function AdminUpdatesBanner({ session }: { session: Session }) {
  const eligible = !!session.me?.is_admin && !session.viewAs;
  const { pathname } = useLocation();
  const onPage = pathname === PAGE || pathname.startsWith(`${PAGE}/`);
  const [counts, setCounts] = useState<BannerCounts | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const lastFetch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const wasOnPage = useRef(onPage);

  const refresh = useCallback(() => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    lastFetch.current = Date.now();
    void loadBannerCounts(c.signal).then((next) => {
      if (!c.signal.aborted) setCounts(next);
    });
  }, []);

  // Once per session for an admin (and again if the identity changes).
  useEffect(() => {
    if (!eligible) {
      setCounts(null);
      return;
    }
    refresh();
    return () => {
      controller.current?.abort();
    };
  }, [eligible, session.me?.email, refresh]);

  // On focus, at most every 5 minutes.
  useEffect(() => {
    if (!eligible) return;
    const onFocus = () => {
      if (Date.now() - lastFetch.current >= BANNER_REFRESH_MS) refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [eligible, refresh]);

  // Decisions happen on the Platform updates page: leaving it picks up the new counts.
  useEffect(() => {
    if (eligible && wasOnPage.current && !onPage) refresh();
    wasOnPage.current = onPage;
  }, [eligible, onPage, refresh]);

  const show = eligible && !onPage && bannerVisible(counts) && dismissed !== bannerSignature(counts);

  return (
    <AnimatePresence initial={false}>
      {show && counts && (
        <motion.div
          key="platform-updates"
          role="status"
          aria-label="Platform updates"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="shrink-0 overflow-hidden border-b border-primary/30 bg-primary/10"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-ui-sm">
            {counts.attention > 0 && counts.ready === 0 ? (
              <TriangleAlert size={15} aria-hidden className="shrink-0 text-destructive" />
            ) : (
              <RefreshCcwDot size={15} aria-hidden className="shrink-0 text-primary" />
            )}
            <span className="min-w-0 font-semibold">{bannerText(counts)}</span>
            <Link to={PAGE + "#updates"} className="rounded-md font-bold text-primary underline-offset-2 hover:underline">
              Review
            </Link>
            <button
              type="button"
              aria-label="Dismiss the platform updates banner"
              onClick={() => {
                const sig = bannerSignature(counts);
                writeDismissed(sig);
                setDismissed(sig);
              }}
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
