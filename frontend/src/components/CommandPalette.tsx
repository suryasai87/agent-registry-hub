// Cmd/Ctrl+K command palette: fuzzy search over pages, actions and (later) registry entities.
// ARIA combobox: focus stays in the input; arrow keys move aria-activedescendant through the listbox.
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { fuzzyFilter } from "../lib/fuzzy";
import { Kbd, useFocusTrap } from "./ui";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  icon?: LucideIcon;
  keywords?: string[];
  perform: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  items,
  placeholder = "Search pages and actions",
  limit = 50,
}: {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  placeholder?: string;
  limit?: number;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useFocusTrap<HTMLDivElement>(open, onClose);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const results = useMemo(
    () => fuzzyFilter(items, query, (i) => [i.label, ...(i.keywords ?? []), i.hint, i.group]).slice(0, limit),
    [items, query, limit],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(optionId(active));
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
    // optionId only depends on baseId, which is stable.
  }, [active, open, results.length]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.perform();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = results.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) setActive((a) => (a + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((a) => (a - 1 + n) % n);
    } else if (e.key === "PageDown" || (e.key === "End" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      if (n) setActive(n - 1);
    } else if (e.key === "PageUp" || (e.key === "Home" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="palette" className="fixed inset-0 z-[95] flex items-start justify-center px-4 pt-[12vh]">
          <motion.div aria-hidden className="absolute inset-0 bg-black/55 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            tabIndex={-1}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl focus:outline-none"
          >
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden />
              <input
                data-autofocus
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={results.length ? optionId(active) : undefined}
                aria-label="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                spellCheck={false}
                autoComplete="off"
                className="h-12 w-full bg-transparent text-ui-md text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <Kbd>Esc</Kbd>
            </div>
            <ul id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
              {results.map((item, i) => {
                const Icon = item.icon;
                const selected = i === active;
                return (
                  <li
                    key={item.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(item)}
                    className={cx("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", selected ? "bg-accent text-accent-foreground" : "text-foreground")}
                  >
                    <span className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-md", selected ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")}>
                      {Icon && <Icon size={15} aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-base font-semibold">{item.label}</span>
                      {item.hint && <span className="block truncate text-ui-xs text-muted-foreground">{item.hint}</span>}
                    </span>
                    {item.group && <span className="shrink-0 text-ui-xs text-muted-foreground">{item.group}</span>}
                    {selected && <CornerDownLeft size={14} className="shrink-0 text-muted-foreground" aria-hidden />}
                  </li>
                );
              })}
            </ul>
            {results.length === 0 && (
              <p role="status" className="px-4 pb-6 pt-2 text-center text-ui-sm text-muted-foreground">
                No matches for “{query}”
              </p>
            )}
            <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-ui-xs text-muted-foreground">
              <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span>
              <span><Kbd>Enter</Kbd> to open</span>
              <span className="ml-auto">{results.length} result{results.length === 1 ? "" : "s"}</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
