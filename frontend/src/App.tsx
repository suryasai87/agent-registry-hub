// Router: every page is lazy-loaded behind a Suspense skeleton and its own ErrorBoundary, inside the shell.
// Add a page: append its entry to components/nav.ts and register its lazy component in PAGES below.
import { MotionConfig, motion } from "framer-motion";
import { Suspense, lazy, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import Shell, { APP_NAME } from "./components/Shell";
import { NAV } from "./components/nav";
import { Card, Skeleton, ToastProvider } from "./components/ui";
import { SessionProvider } from "./lib/session";
import { entrance } from "./lib/motion";

export const PAGES: Record<string, LazyExoticComponent<ComponentType>> = {
  "/how-it-works": lazy(() => import("./pages/HowItWorks")),
  "/home": lazy(() => import("./pages/Home")),
  "/catalog": lazy(() => import("./pages/Catalog")),
  "/me": lazy(() => import("./pages/MyWorkspace")),
  "/requests": lazy(() => import("./pages/Requests")),
  "/changes": lazy(() => import("./pages/Changes")),
  "/lineage": lazy(() => import("./pages/Lineage")),
  "/usage-cost": lazy(() => import("./pages/UsageCost")),
  "/quality": lazy(() => import("./pages/Quality")),
  "/policies": lazy(() => import("./pages/Policies")),
  "/governance": lazy(() => import("./pages/Governance")),
  "/audit": lazy(() => import("./pages/Audit")),
  "/register": lazy(() => import("./pages/Register")),
  "/notifications": lazy(() => import("./pages/Notifications")),
  "/platform-updates": lazy(() => import("./pages/PlatformUpdates")),
};

/** Routes that are not sidebar entries (entity pages, detail pages). Paths use react-router patterns. */
export const EXTRA_ROUTES: { path: string; title: string; component: LazyExoticComponent<ComponentType> }[] = [
  { path: "/assets/:assetId/:tab?", title: "Asset", component: lazy(() => import("./pages/AssetPage")) },
  { path: "/changes/:changeId", title: "Impact report", component: lazy(() => import("./pages/ChangeDetail")) },
];

const NotFound = lazy(() => import("./pages/NotFound"));

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading page" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-32" />
          </Card>
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

/** One route: document title, a route-level error boundary (reset on navigation) and the lazy-load fallback. */
function Page({ title, children }: { title: string; children: ReactNode }) {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
  return (
    <ErrorBoundary name={title} resetKey={pathname}>
      <Suspense fallback={<PageSkeleton />}>
        <motion.div key={pathname} {...entrance}>
          {children}
        </motion.div>
      </Suspense>
    </ErrorBoundary>
  );
}

function ShellLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

export function AppRoutes() {
  const routed = NAV.filter((item) => PAGES[item.path]);
  return (
    <Routes>
      <Route element={<ShellLayout />}>
        <Route index element={<Navigate to="/home" replace />} />
        {routed.map((item) => {
          const Component = PAGES[item.path];
          return (
            <Route
              key={item.path}
              path={item.path}
              element={
                <Page title={item.label}>
                  <Component />
                </Page>
              }
            />
          );
        })}
        {EXTRA_ROUTES.map((r) => (
          <Route
            key={r.path}
            path={r.path}
            element={
              <Page title={r.title}>
                <r.component />
              </Page>
            }
          />
        ))}
        <Route
          path="*"
          element={
            <Page title="Not found">
              <NotFound />
            </Page>
          }
        />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary name={APP_NAME} fullPage>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <SessionProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </SessionProvider>
        </ToastProvider>
      </MotionConfig>
    </ErrorBoundary>
  );
}
