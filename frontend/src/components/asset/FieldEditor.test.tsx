import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldValue } from "../../lib/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";
import FieldEditor from "./FieldEditor";

const ASSET = "mcp:connection:github_mcp";
const BASE = `/api/assets/${encodeURIComponent(ASSET)}/fields`;

function field(overrides: Partial<FieldValue> = {}): FieldValue {
  return {
    field_key: "purpose",
    label: "Purpose",
    kind: "text",
    value: "Repository and pull-request tools.",
    source_value: "Repository and pull-request tools.",
    source_label: "UC connection comment",
    source_synced_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    override_value: null,
    provenance: "source",
    lock_mode: "keep",
    overridden_by: null,
    overridden_at: null,
    override_reason: null,
    drift: false,
    required: true,
    ...overrides,
  };
}

const STEWARD = { can_edit: true, can_override: true };
const OWNER = { can_edit: true, can_override: false };

function captureFetch(respond: (path: string, method: string, body: unknown) => [number, unknown]) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const [status, payload] = respond(path, method, body);
    return jsonResponse(payload, status);
  });
  return calls;
}

describe("FieldEditor provenance chips", () => {
  it("labels auto-pulled, owner-edited and admin-overridden values", () => {
    const { unmount } = renderWithProviders(<FieldEditor assetId={ASSET} field={field()} permissions={OWNER} onChange={() => {}} />);
    expect(screen.getByLabelText(/Provenance: Auto-pulled · UC connection comment · 2 h ago/)).toHaveAttribute("data-provenance", "source");
    unmount();

    const owner = renderWithProviders(
      <FieldEditor assetId={ASSET} field={field({ field_key: "limitations", label: "Known limitations", kind: "longtext", source_value: null, source_label: null, value: "No **PHI**.", override_value: "No **PHI**.", provenance: "owner", overridden_by: "ana@example.com", overridden_at: "2026-10-20T10:00:00Z" })} permissions={OWNER} onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Provenance: Edited by owner")).toHaveAttribute("data-provenance", "owner");
    expect(screen.getByText("PHI").tagName).toBe("STRONG");
    owner.unmount();

    renderWithProviders(
      <FieldEditor assetId={ASSET} field={field({ value: "Curated purpose", override_value: "Curated purpose", provenance: "admin", overridden_by: "r.patel@example.com", overridden_at: "2026-10-20T10:00:00Z", override_reason: "Vendor text was misleading" })} permissions={STEWARD} onChange={() => {}} />,
    );
    const chip = screen.getByLabelText(/Provenance: Edited by admin · r\.patel@example\.com · /);
    expect(chip).toHaveAttribute("data-provenance", "admin");
    expect(chip.className).toContain("text-primary");
  });

  it("does not let an owner override a synced field (only stewards/admins can)", () => {
    renderWithProviders(<FieldEditor assetId={ASSET} field={field()} permissions={OWNER} onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Override Purpose" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Purpose" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Synced field: locked for owners" })).toBeInTheDocument();
  });
});

describe("FieldEditor override", () => {
  it("requires a reason, then PUTs value + reason + lock mode (not optimistically)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const saved = field({ value: "Governed GitHub tools", override_value: "Governed GitHub tools", provenance: "admin", overridden_by: "steward@example.com", overridden_at: "2026-10-26T10:00:00Z", override_reason: "Clarify scope", lock_mode: "follow" });
    const calls = captureFetch(() => [200, saved]);
    renderWithProviders(<FieldEditor assetId={ASSET} field={field()} permissions={STEWARD} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Override Purpose" }));
    const input = await screen.findByRole("textbox", { name: "Purpose" });
    await user.clear(input);
    await user.type(input, "Governed GitHub tools");
    await user.click(screen.getByRole("button", { name: "Save override" }));
    expect(await screen.findByText("A reason is required to override a synced value.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Reason for the override (required)"), "Clarify scope");
    await user.click(screen.getByRole("radio", { name: /Follow source on next sync/ }));
    await user.click(screen.getByRole("button", { name: "Save override" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(saved));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`${BASE}/purpose`);
    expect(put?.body).toEqual({ value: "Governed GitHub tools", reason: "Clarify scope", lock_mode: "follow" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("owner edits of owner-authored fields are optimistic and offer Undo", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    let release: (r: Response) => void = () => {};
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const f = field({ field_key: "support_channel", label: "Support channel", source_value: null, source_label: null, value: null, required: false });
    renderWithProviders(<FieldEditor assetId={ASSET} field={f} permissions={OWNER} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Edit Support channel" }));
    await user.type(await screen.findByRole("textbox", { name: "Support channel" }), "#github-mcp-help");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // applied before the server answers
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ value: "#github-mcp-help", provenance: "owner" }));
    release(jsonResponse({ ...f, value: "#github-mcp-help", override_value: "#github-mcp-help", provenance: "owner" }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});

describe("FieldEditor drift", () => {
  const drifted = field({ value: "Our curated text", override_value: "Our curated text", source_value: "New vendor text", provenance: "admin", overridden_by: "steward@example.com", overridden_at: "2026-10-01T00:00:00Z", drift: true });

  it("shows source vs override side by side and resolves with Accept source", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const accepted = field({ value: "New vendor text", source_value: "New vendor text" });
    const calls = captureFetch(() => [200, accepted]);
    renderWithProviders(<FieldEditor assetId={ASSET} field={drifted} permissions={STEWARD} onChange={onChange} />);
    expect(screen.getByText("The source changed since this value was overridden")).toBeInTheDocument();
    expect(screen.getByText("New vendor text")).toBeInTheDocument();
    expect(screen.getAllByText("Our curated text").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Keep override" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept source" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(accepted));
    expect(calls[0]).toEqual({ path: `${BASE}/purpose/resolve-drift`, method: "POST", body: { action: "accept_source" } });
  });

  it("Keep override posts action keep; owners only see that a steward must review", async () => {
    const user = userEvent.setup();
    const calls = captureFetch(() => [200, { ...drifted, drift: false }]);
    const { unmount } = renderWithProviders(<FieldEditor assetId={ASSET} field={drifted} permissions={STEWARD} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Keep override" }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ action: "keep" }));
    unmount();

    renderWithProviders(<FieldEditor assetId={ASSET} field={drifted} permissions={OWNER} onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Accept source" })).not.toBeInTheDocument();
    expect(screen.getByText("A steward or admin needs to review this drift.")).toBeInTheDocument();
  });
});
