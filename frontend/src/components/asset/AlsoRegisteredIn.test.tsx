import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldValue, Registration } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { recordFetch } from "../workspace/fetchRecorder.test-utils";
import AlsoRegisteredIn, { matchLabel } from "./AlsoRegisteredIn";

const GENIE = "agent:genie:demo-claims";
const ENTRY: Registration = { registry: "Microsoft Agent 365", id: "T_6f1c2a90-0d4e-4c55-9a8e-1b2c3d4e5f60", url: "https://dbc-a1b2c3d4-e5f6.cloud.databricks.com/genie/rooms/demo-claims",
  display_name: "Claims Analytics", platform: "Databricks Genie", match: "genie_space_id", confidence: 1 };
const FIELD: FieldValue = { field_key: "also_registered_in", label: "Also registered in", kind: "registrations", value: [ENTRY], source_value: [ENTRY],
  source_label: "Microsoft Agent 365", source_synced_at: new Date(Date.now() - 2 * 3600_000).toISOString(), override_value: null, provenance: "source",
  lock_mode: "keep", overridden_by: null, overridden_at: null, override_reason: null, drift: false, required: false };

describe("Also registered in", () => {
  it("shows the Microsoft ID, the registry link, how it matched and the provenance", () => {
    renderWithProviders(<AlsoRegisteredIn assetId={GENIE} items={[ENTRY]} field={FIELD} canOverride={false} onChanged={() => {}} />);
    const list = screen.getByRole("list", { name: "Also registered in" });
    expect(within(list).getByRole("link", { name: /Microsoft Agent 365/ })).toHaveAttribute("href", ENTRY.url);
    expect(within(list).getByText(ENTRY.id)).toBeInTheDocument();
    expect(within(list).getByText("Databricks Genie")).toBeInTheDocument();
    expect(within(list).getByText("“Claims Analytics” · Matched by Genie space id")).toBeInTheDocument();
    expect(screen.getByLabelText(/Provenance: Auto-pulled · Microsoft Agent 365 · 2 h ago/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unlink/ })).not.toBeInTheDocument();
    expect(matchLabel({ ...ENTRY, match: "name", confidence: 0.9 })).toBe("Matched by name · 90%");
    expect(matchLabel({ ...ENTRY, match: "steward" })).toBe("Linked by a steward");
  });

  it("lets a steward unlink a wrong match with a reason (an override that later syncs keep)", async () => {
    const user = userEvent.setup();
    const next: FieldValue = { ...FIELD, value: [], override_value: [], provenance: "admin", overridden_by: "lee.chen@example.com", override_reason: "Wrong agent" };
    const url = `/api/assets/${encodeURIComponent(GENIE)}/fields/also_registered_in`;
    const rec = recordFetch({ [`PUT ${url}`]: next });
    const onChanged = vi.fn();
    renderWithProviders(<AlsoRegisteredIn assetId={GENIE} items={[ENTRY]} field={FIELD} canOverride onChanged={onChanged} />);
    await user.click(screen.getByRole("button", { name: `Unlink Microsoft Agent 365 ${ENTRY.id}` }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Reason/), "Wrong agent");
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(next));
    expect(rec.last("PUT", url)!.body).toEqual({ value: [], reason: "Wrong agent", lock_mode: "keep" });
  });

  it("offers a revert after an admin override and flags drift", () => {
    const over: FieldValue = { ...FIELD, value: [], override_value: [], provenance: "admin", overridden_by: "lee.chen@example.com", drift: true };
    renderWithProviders(<AlsoRegisteredIn assetId={GENIE} items={[]} field={over} canOverride onChanged={() => {}} />);
    expect(screen.getByText("None (unlinked by an admin)")).toBeInTheDocument();
    expect(screen.getByText("Source changed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revert to synced" })).toBeInTheDocument();
  });
});
