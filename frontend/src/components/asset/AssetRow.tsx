// Catalog list view (benchmark §3.4 list columns): one row per asset in a native table.
import { BellPlus, KeyRound } from "lucide-react";
import { Link } from "react-router-dom";
import { assetHref, fmtAgo, fmtNum, fmtPct, fmtUsd } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AssetCard } from "../../lib/types";
import { IconButton } from "../ui";
import { AssetIcon, type CardActions } from "./AssetCard";
import { AssetTypeBadge, CardStatus, OwnerStack, PolicyShield, RelationshipPills, RiskBadge, TrustBadge } from "./badges";
import { sourceChipLabel } from "./meta";
import { prefetchAsset } from "./prefetch";
import { DataTable, Td, Th } from "./primitives";

export function AssetRow({ card, compact, onSubscribe, onRequestAccess }: { card: AssetCard; compact?: boolean } & CardActions) {
  const warm = () => prefetchAsset(card.asset_id);
  return (
    <tr onMouseEnter={warm} data-asset-id={card.asset_id} className="group hover:bg-accent/40 focus-within:bg-accent/40">
      <Td className="min-w-[240px]">
        <div className="flex items-center gap-2.5">
          {!compact && <AssetIcon type={card.asset_type} size={30} />}
          <div className="min-w-0">
            <Link to={assetHref(card.asset_id)} onFocus={warm} className="block truncate text-ui-base font-semibold hover:text-primary">
              {card.display_name}
            </Link>
            <span title={card.asset_id} className="block max-w-[280px] truncate font-mono text-ui-xs text-muted-foreground">
              {card.asset_id}
            </span>
          </div>
        </div>
      </Td>
      <Td>
        <AssetTypeBadge type={card.asset_type} />
      </Td>
      <Td className="max-w-[180px] truncate text-muted-foreground">
        <span title={sourceChipLabel(card)}>{sourceChipLabel(card)}</span>
      </Td>
      <Td>
        <OwnerStack owners={card.owners} size={22} />
      </Td>
      <Td className="whitespace-nowrap">
        <CardStatus card={card} />
      </Td>
      <Td>
        <TrustBadge certification={card.certification} />
      </Td>
      <Td>
        <RiskBadge risk={card.risk_tier} />
      </Td>
      <Td>
        <PolicyShield shield={card.policy_shield} coveragePct={card.coverage_pct} />
      </Td>
      <Td align="right">{fmtNum(card.subscribers)}</Td>
      <Td align="right">{fmtNum(card.kpi.requests_30d)}</Td>
      <Td align="right">{fmtUsd(card.kpi.cost_30d_usd)}</Td>
      <Td align="right">{fmtPct(card.kpi.error_rate)}</Td>
      <Td className="whitespace-nowrap text-muted-foreground">{fmtAgo(card.last_changed_at)}</Td>
      <Td>
        <RelationshipPills my={card.my} />
      </Td>
      <Td>
        <div className="flex justify-end gap-1">
          {!card.my.subscribed && onSubscribe && <IconButton size="sm" label={`Subscribe to ${card.display_name}`} icon={<BellPlus size={14} aria-hidden />} onClick={() => onSubscribe(card)} />}
          {!card.my.has_access && !card.my.requested && !card.my.owner && onRequestAccess && (
            <IconButton size="sm" label={`Request access to ${card.display_name}`} icon={<KeyRound size={14} aria-hidden />} onClick={() => onRequestAccess(card)} />
          )}
        </div>
      </Td>
    </tr>
  );
}

export default function AssetTable({ items, compact = false, ...actions }: { items: AssetCard[]; compact?: boolean } & CardActions) {
  return (
    <DataTable label="Catalog results" dense={compact} className={cx(compact && "[&_td]:text-ui-xs")}>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Type</Th>
          <Th>Source</Th>
          <Th>Owner</Th>
          <Th>Status</Th>
          <Th>Certification</Th>
          <Th>Risk</Th>
          <Th>Policy coverage</Th>
          <Th align="right">Subscribers</Th>
          <Th align="right">30 d requests</Th>
          <Th align="right">30 d cost</Th>
          <Th align="right">Error rate</Th>
          <Th>Last changed</Th>
          <Th>You</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {items.map((card) => (
          <AssetRow key={card.asset_id} card={card} compact={compact} {...actions} />
        ))}
      </tbody>
    </DataTable>
  );
}
