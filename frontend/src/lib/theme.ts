// Light/dark theme: persisted to localStorage and applied as .dark / .light on <html>.
// index.html applies the stored value before first paint so there is no flash of the wrong theme.
import { useCallback, useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";

export type Theme = "dark" | "light";
export const THEME_KEY = "arh.theme";
export const DEFAULT_THEME: Theme = "dark";

const listeners = new Set<() => void>();

export function storedTheme(): Theme {
  const raw = readStored(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export function setTheme(theme: Theme): void {
  writeStored(THEME_KEY, theme);
  applyTheme(theme);
  listeners.forEach((notify) => notify());
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** [theme, setTheme, toggle] backed by the <html> class, shared by every component that uses it. */
export function useTheme(): [Theme, (theme: Theme) => void, () => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => DEFAULT_THEME);
  const toggle = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return [theme, setTheme, toggle];
}
