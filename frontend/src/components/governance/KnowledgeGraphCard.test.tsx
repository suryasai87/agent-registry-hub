import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { KgPreview, KgStatus } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { envelope, recordFetch } from "../workspace/fetchRecorder.test-utils";
import { KnowledgeGraphCard } from "./KnowledgeGraphCard";

const NS = "https://agent-registry-hub.example/ontology#";
const PREVIEW: KgPreview = {
  available: true, can_export: true, mode: "record_only", namespace: NS, digest: "d1g3st", triples: 24427,
  classes: [{ iri: `${NS}Agent`, name: "Agent", label: "Agent", count: 321 }, { iri: `${NS}GenieAgent`, name: "GenieAgent", label: "Genie agent", count: 230 }],
  predicates: [{ iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", name: "type", label: "type", count: 3762, kind: "rdf" },
    { iri: `${NS}usesMcp`, name: "usesMcp", label: "uses MCP server", count: 6, kind: "object" }],
  samples: [], skipped: [{ reason: "People and service principals are never exported (counted on the asset instead)", count: 35, sample: [] }],
  target: { catalog: "main", schema: "agent_kg", version: 1, base: "triplestore_agent_registry_hub_V1", source: "setting",
    data_table: "main.agent_kg.triplestore_agent_registry_hub_V1_data" },
  objects: [{ role: "data", name: "main.agent_kg.triplestore_agent_registry_hub_V1_data", kind: "TABLE", comment: "", explorer_url: null },
    { role: "kg_nodes", name: "main.agent_kg.kg_nodes", kind: "VIEW", comment: "", explorer_url: null }],
  statements: [{ step: "data", sql: "CREATE OR REPLACE TABLE `main`.`agent_kg`.`triplestore_agent_registry_hub_V1_data` USING DELTA CLUSTER BY (predicate, subject)" }],
  load: { stage: "main.agent_kg.triplestore_agent_registry_hub_V1_stage", batches: 6, rows: 24427, max_statement_bytes: 900000, largest_statement_bytes: 899969, total_bytes: 5000000 },
  explorer_url: "https://ws.example/explore/data/main/agent_kg/triplestore_agent_registry_hub_v1_data",
  last_run: null, unchanged_since_last_run: false,
};
const STATUS: KgStatus = {
  available: true, can_export: true, target: PREVIEW.target, settings: { export_in_sync: false, catalog: "main", schema: "agent_kg", version: 1, bundle_target: null },
  runs: [{ run_id: 3, triggered_by: "admin@example.com", mode: "record_only", acting_as: null, target: "main.agent_kg.triplestore_agent_registry_hub_V1",
    digest: "old", status: "succeeded", counts: { triples: 24000 }, conflicts: [], error: null, started_at: "2026-10-27T10:00:00Z", finished_at: "2026-10-27T10:00:05Z" }],
};

describe("Knowledge graph (Delta)", () => {
  it("shows the target, counts, digest, last run and deep link, and exports exactly the previewed digest", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/kg/preview": envelope(PREVIEW), "/api/kg/status": envelope(STATUS),
      "POST /api/kg/export": { run_id: 4, status: "succeeded", mode: "record_only", acting_as: null, digest: "d1g3st", target: PREVIEW.target,
        counts: { triples: 24427 }, conflicts: [], error: null, statements: [{ step: "stage", sql: "CREATE …" }, { step: "load", sql: "INSERT …" }], explorer_url: null },
    });
    renderWithProviders(<KnowledgeGraphCard canExport />);
    expect(await screen.findByText("main.agent_kg.triplestore_agent_registry_hub_V1_data")).toBeInTheDocument();
    expect(screen.getByText("Record only: nothing is sent")).toBeInTheDocument();
    expect(document.querySelector('[data-count="triples"]')).toHaveTextContent("24,427");
    expect(document.querySelector("[data-digest]")).toHaveTextContent("d1g3st");
    expect(document.querySelector('[data-term="Classes:GenieAgent"]')).toHaveTextContent("230");
    expect(screen.getByLabelText("Predicates")).not.toHaveTextContent("3,762"); // rdf:type / rdfs:label are infrastructure, not listed
    expect(screen.getByRole("link", { name: /Open in Catalog Explorer/ })).toHaveAttribute("href", PREVIEW.explorer_url);
    expect(screen.getByRole("link", { name: /Ontology \(.ttl\)/ })).toHaveAttribute("href", "/api/kg/ontology.ttl");
    expect(await screen.findByText("#3")).toBeInTheDocument();
    expect(screen.getByText(/Left out \(35\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export the knowledge graph" });
    expect(within(dialog).getByText(/Only objects the hub created are replaced/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(rec.last("POST", "/api/kg/export")).toBeDefined());
    expect(rec.last("POST", "/api/kg/export")!.body).toEqual({ digest: "d1g3st" });
    expect(await screen.findByText(/2 statement\(s\) recorded, none sent/)).toBeInTheDocument();
  });

  it("lets only admins export or change the target and the sync step; shows conflicts from a refused run", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/kg/preview": envelope({ ...PREVIEW, can_export: false }), "/api/kg/status": envelope({ ...STATUS, can_export: false }) });
    const view = renderWithProviders(<KnowledgeGraphCard canExport={false} />);
    await screen.findByText("main.agent_kg.triplestore_agent_registry_hub_V1_data");
    expect(screen.queryByRole("button", { name: /Export/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Export during the hourly sync/ })).not.toBeInTheDocument();
    view.unmount();

    const rec = recordFetch({
      "/api/kg/preview": envelope(PREVIEW), "/api/kg/status": envelope(STATUS),
      "PUT /api/kg/settings": { ...STATUS.settings, export_in_sync: true },
      "POST /api/kg/export": { run_id: 5, status: "conflict", mode: "platform", acting_as: "app service principal", digest: "d1g3st", target: PREVIEW.target,
        counts: {}, conflicts: [{ role: "kg_nodes", name: "main.agent_kg.kg_nodes", kind: "VIEW", reason: "exists and was not created by the Agent Registry Hub: left untouched" }],
        error: null, statements: [], explorer_url: null },
    });
    renderWithProviders(<KnowledgeGraphCard canExport />);
    await user.click(await screen.findByRole("switch", { name: /Export during the hourly sync/ }));
    await waitFor(() => expect(rec.last("PUT", "/api/kg/settings")!.body).toEqual({ export_in_sync: true }));
    await user.click(screen.getByRole("button", { name: "Save target" }));
    await waitFor(() => expect(rec.writes().filter((c) => c.method === "PUT").at(-1)!.body).toEqual({ catalog: "main", schema: "agent_kg" }));
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Export" }));
    expect(await screen.findByText(/left untouched/)).toBeInTheDocument();
  });

  it("degrades instead of crashing: not available, no target, failing endpoints", async () => {
    recordFetch({ "/api/kg/preview": envelope({ ...PREVIEW, available: false, note: "Migration 008 is not applied yet: run the setup job." }), "/api/kg/status": [500, { detail: "boom" }] });
    const a = renderWithProviders(<KnowledgeGraphCard canExport />);
    expect(await screen.findByText("Migration 008 is not applied yet: run the setup job.")).toBeInTheDocument();
    a.unmount();

    recordFetch({ "/api/kg/preview": envelope({ ...PREVIEW, target: null, objects: [], statements: [], load: null, explorer_url: null, can_export: false,
      note: "No target yet: set the catalog and schema here (admin)." }), "/api/kg/status": [503, { detail: "Lakebase unavailable" }] });
    const b = renderWithProviders(<KnowledgeGraphCard canExport />);
    expect(await screen.findByText(/No target yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(await screen.findByText("Run history is unavailable right now.")).toBeInTheDocument();
    b.unmount();

    recordFetch({ "/api/kg/preview": [500, { detail: "Internal server error" }], "/api/kg/status": [500, { detail: "Internal server error" }] });
    renderWithProviders(<KnowledgeGraphCard canExport />);
    expect(await screen.findByText("Couldn't load the knowledge graph preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    recordFetch({ "/api/kg/preview": envelope({ available: true, can_export: false, digest: null, triples: 0, classes: [], predicates: [], samples: [], skipped: [],
      target: null, objects: [], statements: [], last_run: null }, "synthetic"), "/api/kg/status": envelope(STATUS) });
    renderWithProviders(<KnowledgeGraphCard canExport />);
    expect(await screen.findAllByText("None yet.")).toHaveLength(2);
  });
});
