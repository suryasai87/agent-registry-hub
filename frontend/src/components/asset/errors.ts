// Write-error copy shared by every mutation: the backend's {detail} with role/state/availability framing.
import { useCallback } from "react";
import { ApiError } from "../../lib/api";
import { useToast } from "../ui";

/** 403 → "You don't have permission: …", 409 → the detail, 503 → "Changes are unavailable right now". */
export function writeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return `You don't have permission: ${err.detail}`;
    if (err.status === 409) return err.detail;
    if (err.status === 503) return `Changes are unavailable right now${err.detail ? ` (${err.detail})` : ""}`;
    if (err.status === 404) return err.detail || "That item no longer exists";
    return err.detail || `Request failed (HTTP ${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Read-error copy for inline error cards. */
export function readErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This endpoint is not available yet, or the item does not exist.";
    if (err.status === 403) return `You don't have permission: ${err.detail}`;
    return err.detail || `Request failed (HTTP ${err.status})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** toast.error(title, writeErrorMessage(err)). */
export function useWriteError(): (title: string, err: unknown) => void {
  const toast = useToast();
  return useCallback((title: string, err: unknown) => {
    toast.error(title, writeErrorMessage(err));
  }, [toast]);
}
