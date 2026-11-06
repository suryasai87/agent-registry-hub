// localStorage that never throws (private mode, blocked storage, SSR-like test environments).

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference simply is not persisted */
  }
}

export function readBool(key: string, fallback: boolean): boolean {
  const raw = readStored(key);
  return raw === null ? fallback : raw === "true";
}
