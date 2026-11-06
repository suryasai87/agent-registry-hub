// Coverage / completeness meters: a segmented ring with the number beside it, plus the checklist of what is
// met and what is missing (actionable rows, never colour alone).
import { motion } from "framer-motion";
import { CircleCheck, CircleX } from "lucide-react";
import { cx } from "../../lib/cx";
import { toneForPct } from "./primitives";

const TONE_STROKE = { success: "hsl(var(--success))", warning: "hsl(var(--warning))", destructive: "hsl(var(--destructive))" } as const;

export function Ring({ pct, size = 64, label }: { pct: number; size?: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const tone = toneForPct(v);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-valuetext={`${v}%`} className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={6} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v / 100) }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-ui-md font-extrabold tabular-nums">{v}%</span>
    </div>
  );
}

export default function CoverageMeter({ pct, title, subtitle, items, className }: { pct: number; title: string; subtitle?: string; items?: { key: string; label: string; met: boolean }[]; className?: string }) {
  const met = items?.filter((i) => i.met).length ?? 0;
  return (
    <div className={cx("space-y-3", className)}>
      <div className="flex items-center gap-4">
        <Ring pct={pct} label={title} />
        <div className="min-w-0">
          <div className="text-ui-md font-bold">{title}</div>
          <div className="text-ui-sm text-muted-foreground">{subtitle ?? (items ? `${met} of ${items.length} requirements met` : null)}</div>
        </div>
      </div>
      {items && items.length > 0 && (
        <ul className="space-y-1">
          {[...items]
            .sort((a, b) => Number(a.met) - Number(b.met))
            .map((it) => (
              <li key={it.key} className={cx("flex items-center gap-2 rounded-lg px-2 py-1 text-ui-sm", !it.met && "bg-destructive/6")}>
                {it.met ? <CircleCheck size={14} className="shrink-0 text-success" aria-hidden /> : <CircleX size={14} className="shrink-0 text-destructive" aria-hidden />}
                <span className="sr-only">{it.met ? "Met:" : "Missing:"}</span>
                <span className={cx("min-w-0 flex-1", !it.met && "font-medium")}>{it.label}</span>
                {!it.met && <span className="text-ui-xs font-semibold text-destructive">Missing</span>}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
