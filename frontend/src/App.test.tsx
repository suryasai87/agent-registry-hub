import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "./App";
import { HEALTH_OK, mockFetch, renderWithProviders } from "./test/utils";

describe("routes", () => {
  it("redirects / to Home", async () => {
    renderWithProviders(<AppRoutes />, { route: "/" });
    await waitFor(() => expect(document.title).toBe("Home · Agent Registry Hub"));
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: /Home/ })).toHaveAttribute("aria-current", "page");
  });

  it("renders How It Works: the four-lane flow, the steps and the live status", async () => {
    mockFetch({ "/api/health": [200, HEALTH_OK] });
    renderWithProviders(<AppRoutes />, { route: "/how-it-works" });
    expect(await screen.findByRole("heading", { level: 1, name: "How It Works" })).toBeInTheDocument();
    expect(screen.getByText("Lakebase registry")).toBeInTheDocument();
    expect(screen.getByText("Collectors (sync job)")).toBeInTheDocument();
    for (const lane of ["Lane 1 · Discover", "Lane 2 · Measure", "Lane 3 · Govern", "Lane 4 · Consume & impact"]) {
      expect(screen.getAllByText(lane).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("STEPS 13–18")).toBeInTheDocument();
    expect(screen.getByText("What the registry tracks")).toBeInTheDocument();
    expect(await screen.findByText("connected · 4.2 ms")).toBeInTheDocument();
    expect(document.title).toBe("How It Works · Agent Registry Hub");
  });

  it("shows a friendly 404 inside the shell for an unknown route", async () => {
    renderWithProviders(<AppRoutes />, { route: "/no/such/page" });
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(screen.getByText("/no/such/page")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: /How It Works/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to How It Works" })).toHaveAttribute("href", "/how-it-works");
  });
});
