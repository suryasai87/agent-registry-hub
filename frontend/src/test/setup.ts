// Test environment: jest-dom matchers, the browser APIs jsdom lacks (matchMedia for framer-motion's
// reduced-motion query, ResizeObserver for layout animation), and a hermetic default fetch.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

beforeEach(() => {
  // No test reaches a network: unknown endpoints answer like the backend's JSON 404.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify({ detail: `Not Found: ${url}` }), { status: 404, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "dark";
  window.history.replaceState(null, "", "/");
});
