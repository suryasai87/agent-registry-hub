// Debounced asset search (GET /api/search?q=) as an ARIA combobox: type, arrow through results, Enter to pick.
import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api, enc } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { SearchHit } from "../../lib/types";
import { ENTITY_TYPES } from "../ui";
import { ENTITY_OF } from "./chips";

export function useDebounced<T>(value: T, ms = 220): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => {
      clearTimeout(t);
    };
  }, [value, ms]);
  return v;
}

export default function AssetSearch({
  onPick,
  placeholder = "Search agents, MCP servers, tools, skills",
  label = "Search assets",
  kinds = ["asset"],
  className,
  autoFocus = false,
}: {
  onPick: (hit: SearchHit) => void;
  placeholder?: string;
  label?: string;
  kinds?: SearchHit["kind"][];
  className?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim());
  const baseId = useId();
  const kindsKey = kinds.join(",");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounced.length < 2) {
      setHits([]);
      setFailed(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api.get<SearchHit[]>(`/api/search?q=${enc(debounced)}`, { signal: controller.signal }).then(
      (env) => {
        if (controller.signal.aborted) return;
        const allowed = new Set(kindsKey.split(","));
        setHits((env.data ?? []).filter((h) => allowed.has(h.kind)).slice(0, 12));
        setActive(0);
        setFailed(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setHits([]);
        setFailed(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    return () => {
      controller.abort();
    };
  }, [debounced, kindsKey]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onPick(hit);
    setQ("");
    setHits([]);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (hits.length) setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length) setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      if (open && hits[active]) {
        e.preventDefault();
        pick(hits[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const listId = `${baseId}-list`;
  const showList = open && debounced.length >= 2;
  return (
    <div ref={wrapRef} className={cx("relative", className)}>
      <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        id={`${baseId}-input`}
        name="asset-search"
        type="search"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && hits[active] ? `${baseId}-opt-${active}` : undefined}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="h-9 w-full rounded-lg border border-input bg-background/60 pl-9 pr-8 text-ui-base shadow-sm placeholder:text-muted-foreground/70 hover:border-primary/40"
      />
      {loading && <LoaderCircle size={14} aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />}
      {showList && (
        <ul id={listId} role="listbox" aria-label="Search results" className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
          {hits.map((h, i) => {
            const Icon = h.asset_type && ENTITY_OF[h.asset_type] ? ENTITY_TYPES[ENTITY_OF[h.asset_type]].icon : Search;
            return (
              <li
                key={`${h.kind}:${h.id}`}
                id={`${baseId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
                className={cx("flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5", i === active ? "bg-accent" : undefined)}
              >
                <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-sm font-semibold">{h.label}</span>
                  {h.sublabel && <span className="block truncate text-ui-xs text-muted-foreground">{h.sublabel}</span>}
                </span>
              </li>
            );
          })}
          {!loading && hits.length === 0 && (
            <li role="presentation" className="px-3 py-3 text-center text-ui-sm text-muted-foreground">
              {failed ? `Search failed: ${failed}` : `No matches for “${debounced}”`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
