// Catalog card (benchmark §3.4): type badge + source chip, name + mono URN, trust badge, status dot + label,
// 2-line purpose, KPI micro-row (14-day sparkline, users, cost, policy shield), owner avatars (or an amber
// "Ownerless" chip), my-relationship pills, and hover/focus quick actions (Subscribe, Request access, Open).
import { motion } from "framer-motion";
import { ArrowUpRight, BellPlus, KeyRound, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { assetHref, fmtNum, fmtUsd } from "../../lib/assets";
import { cx } from "../../lib/cx";
import { staggerItem } from "../../lib/motion";
import type { AssetCard as Card } from "../../lib/types";
import { Button, ENTITY_TYPES, TYPE_TONE } from "../ui";
import { AssetTypeBadge, CardStatus, OwnerStack, PolicyShield, RelationshipPills, SourceChip, TrustBadge } from "./badges";
import { ENTITY_OF } from "./meta";
import { prefetchAsset } from "./prefetch";
import Sparkline from "./Sparkline";

export interface CardActions {
  onSubscribe?: (card: Card) => void;
  onRequestAccess?: (card: Card) => void;
}

export function AssetIcon({ type, size = 40, className }: { type: Card["asset_type"]; size?: number; className?: string }) {
  const entity = ENTITY_OF[type] ?? "tool";
  const Icon = ENTITY_TYPES[entity].icon;
  return (
    <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-xl", TYPE_TONE[entity], className)} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.48)} />
    </span>
  );
}

export default function AssetCard({ card, compact = false, onSubscribe, onRequestAccess }: { card: Card; compact?: boolean } & CardActions) {
  const href = assetHref(card.asset_id);
  const canRequest = !card.my.has_access && !card.my.requested && !card.my.owner;
  const canSubscribe = !card.my.subscribed;
  const warm = () => prefetchAsset(card.asset_id);
  return (
    <motion.article
      variants={staggerItem}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      onMouseEnter={warm}
      onFocus={warm}
      aria-labelledby={`card-${card.asset_id}`}
      data-asset-id={card.asset_id}
      className={cx(
        "group relative flex h-full flex-col rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-lg focus-within:border-primary/50",
        compact ? "gap-2 p-3" : "gap-3 p-4",
      )}
    >
      <div className="flex items-start gap-3">
        <AssetIcon type={card.asset_type} size={compact ? 32 : 40} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <AssetTypeBadge type={card.asset_type} />
            <SourceChip card={card} className="max-w-[12rem]" />
          </div>
          <h3 id={`card-${card.asset_id}`} className="truncate text-ui-md font-bold leading-snug">
            <Link to={href} className="rounded-sm after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {card.display_name}
            </Link>
          </h3>
          <p title={card.asset_id} className="truncate font-mono text-ui-xs text-muted-foreground">
            {card.asset_id}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TrustBadge certification={card.certification} />
        <CardStatus card={card} />
        {card.parent_display_name && <span className="truncate text-ui-xs text-muted-foreground">in {card.parent_display_name}</span>}
      </div>

      <p className={cx("text-ui-sm text-muted-foreground", compact ? "line-clamp-1" : "line-clamp-2 min-h-[2.6em]")}>{card.purpose || <span className="italic">No purpose documented yet.</span>}</p>

      <div className="flex items-center gap-3 text-ui-xs text-muted-foreground" aria-label="30-day activity">
        <Sparkline values={card.kpi.spark} label="14-day requests" width={compact ? 56 : 72} />
        <span className="tabular-nums" title="Requests in the last 30 days">
          <span className="font-semibold text-foreground">{fmtNum(card.kpi.requests_30d)}</span> req
        </span>
        <span className="inline-flex items-center gap-1 tabular-nums" title="Active users in the last 30 days">
          <UsersRound size={12} aria-hidden />
          <span className="font-semibold text-foreground">{fmtNum(card.kpi.users_30d)}</span>
          <span className="sr-only">users</span>
        </span>
        <span className="tabular-nums" title="Estimated cost, last 30 days (list price)">
          <span className="font-semibold text-foreground">{fmtUsd(card.kpi.cost_30d_usd)}</span>
          <span className="sr-only"> estimated cost</span>
        </span>
        <PolicyShield shield={card.policy_shield} coveragePct={card.coverage_pct} className="ml-auto" />
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/70 pt-2.5">
        <OwnerStack owners={card.owners} size={compact ? 20 : 24} />
        <RelationshipPills my={card.my} className="ml-auto" />
      </div>

      <div
        className={cx(
          "z-10 flex items-center gap-1.5 rounded-b-xl bg-gradient-to-t from-card from-70% to-card/0 pt-4 transition-opacity duration-150",
          "absolute inset-x-0 bottom-0 px-3 pb-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          "pointer-coarse:static pointer-coarse:bg-none pointer-coarse:p-0 pointer-coarse:opacity-100",
        )}
      >
        {canSubscribe && onSubscribe && (
          <Button size="sm" variant="secondary" icon={<BellPlus size={13} aria-hidden />} onClick={() => onSubscribe(card)} aria-label={`Subscribe to ${card.display_name}`}>
            Subscribe
          </Button>
        )}
        {canRequest && onRequestAccess && (
          <Button size="sm" variant="secondary" icon={<KeyRound size={13} aria-hidden />} onClick={() => onRequestAccess(card)} aria-label={`Request access to ${card.display_name}`}>
            Request access
          </Button>
        )}
        <Link
          to={href}
          aria-label={`Open ${card.display_name}`}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-ui-sm font-semibold text-primary hover:bg-accent"
        >
          Open <ArrowUpRight size={13} aria-hidden />
        </Link>
      </div>
    </motion.article>
  );
}
