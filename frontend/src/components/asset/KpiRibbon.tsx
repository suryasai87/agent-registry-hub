// A compact horizontal KPI ribbon (entity header, usage tab): label, value, optional hint and icon.
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { stagger, staggerItem } from "../../lib/motion";
import { Skeleton } from "../ui";

export interface RibbonItem {
  key: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "warning" | "destructive" | "success";
  /** Numerator/denominator explanation, shown on hover. */
  tooltip?: string;
}

const LG_COLS: Record<number, string> = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5", 6: "lg:grid-cols-6", 7: "lg:grid-cols-4", 8: "lg:grid-cols-4" };

export default function KpiRibbon({ items, loading = false, className, label = "Key metrics" }: { items: RibbonItem[]; loading?: boolean; className?: string; label?: string }) {
  return (
    <div className={cx("overflow-hidden rounded-xl border border-border bg-card", className)}>
    <motion.dl
      aria-label={label}
      variants={stagger}
      initial="hidden"
      animate="show"
      className={cx("-ml-px -mt-px grid grid-cols-2 sm:grid-cols-3", LG_COLS[items.length] ?? "lg:grid-cols-5")}
    >
      {items.map((it) => {
        return (
          <motion.div key={it.key} variants={staggerItem} title={it.tooltip} className="flex min-w-0 flex-col gap-1 border-l border-t border-border px-4 py-3">
            <dt className="flex items-center gap-1.5 truncate text-ui-xs font-medium text-muted-foreground">
              {it.icon}
              {it.label}
            </dt>
            <dd
              className={cx(
                "truncate text-ui-xl font-extrabold leading-none tabular-nums",
                it.tone === "warning" && "text-warning",
                it.tone === "destructive" && "text-destructive",
                it.tone === "success" && "text-success",
              )}
            >
              {loading ? <Skeleton className="h-6 w-16" /> : it.value}
            </dd>
            {it.hint && <dd className="truncate text-ui-xs text-muted-foreground">{it.hint}</dd>}
          </motion.div>
        );
      })}
    </motion.dl>
    </div>
  );
}
