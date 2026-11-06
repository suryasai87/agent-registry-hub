import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DataSource } from "../lib/api";
import { renderWithProviders } from "../test/utils";
import SourcePill from "./SourcePill";

describe("SourcePill", () => {
  it.each<[DataSource, string, string]>([
    ["lakebase", "Lakebase", "text-success"],
    ["warehouse", "Warehouse", "text-info"],
    ["synthetic", "Synthetic", "text-warning"],
    ["live", "Live API", "text-db-teal"],
    ["none", "Unavailable", "text-destructive"],
  ])("renders the %s variant", (source, label, tone) => {
    renderWithProviders(<SourcePill source={source} />);
    const pill = screen.getByLabelText(new RegExp(`^Data source: ${label}`));
    expect(pill).toHaveTextContent(label);
    expect(pill).toHaveAttribute("data-source", source);
    expect(pill.className).toContain(tone);
  });

  it("explains a synthetic answer in a tooltip on hover and on focus", async () => {
    const user = userEvent.setup();
    const reason = "lakebase: LakebaseUnavailable: connection refused; warehouse: WarehouseNotConfigured";
    renderWithProviders(<SourcePill source="synthetic" degradedReason={reason} asOf="2026-10-25T12:00:00+00:00" />);
    const pill = screen.getByLabelText(/^Data source: Synthetic \(degraded:/);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(pill);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Labeled synthetic data");
    expect(tip).toHaveTextContent(reason);
    expect(tip).toHaveTextContent("As of");
    expect(pill).toHaveAttribute("aria-describedby", tip.id);

    await user.unhover(pill);
    await user.tab();
    expect(pill).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
  });

  it("renders nothing without a source", () => {
    const { container } = renderWithProviders(<SourcePill source={null} />);
    expect(container.querySelector("[data-source]")).toBeNull();
    expect(screen.queryByLabelText(/^Data source:/)).not.toBeInTheDocument();
  });
});
