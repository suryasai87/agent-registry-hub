import { Compass } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { NAV } from "../components/nav";
import { EmptyState } from "../components/ui";

export default function NotFound() {
  const { pathname } = useLocation();
  const home = NAV[0];
  return (
    <EmptyState
      className="mt-10"
      icon={<Compass size={22} aria-hidden />}
      title="Page not found"
      description={
        <>
          Nothing lives at <code className="rounded bg-muted px-1.5 py-0.5 text-ui-xs">{pathname}</code>. It may have moved, or the link is mistyped.
        </>
      }
      action={
        <Link to={home.path} className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground hover:brightness-110">
          Go to {home.label}
        </Link>
      }
    />
  );
}
