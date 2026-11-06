import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Server, Settings, Workflow } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../lib/fuzzy";
import { renderWithProviders } from "../test/utils";
import CommandPalette, { type PaletteItem } from "./CommandPalette";

function setup() {
  const perform = { how: vi.fn(), mcp: vi.fn(), settings: vi.fn() };
  const items: PaletteItem[] = [
    { id: "how", label: "How It Works", hint: "Architecture", group: "Page", icon: Workflow, perform: perform.how },
    { id: "mcp", label: "MCP servers", hint: "Model Context Protocol", group: "Page", icon: Server, perform: perform.mcp },
    { id: "settings", label: "Settings", group: "Page", icon: Settings, keywords: ["preferences"], perform: perform.settings },
  ];
  const onClose = vi.fn();
  renderWithProviders(<CommandPalette open onClose={onClose} items={items} />);
  return { perform, onClose, input: screen.getByRole("combobox", { name: "Search" }) };
}

const options = () => within(screen.getByRole("listbox")).queryAllByRole("option");

describe("CommandPalette", () => {
  it("is an ARIA combobox that starts focused with every item listed", () => {
    const { input } = setup();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(options()).toHaveLength(3);
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("fuzzy-filters by label and keywords", async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.type(input, "mcp");
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining("MCP servers")]);

    await user.clear(input);
    await user.type(input, "hiw");
    expect(options()[0]).toHaveTextContent("How It Works");

    await user.clear(input);
    await user.type(input, "prefer");
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("Settings");

    await user.clear(input);
    await user.type(input, "zzzz");
    expect(options()).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
  });

  it("moves with the arrow keys (wrapping) and runs the active item on Enter", async () => {
    const user = userEvent.setup();
    const { input, perform, onClose } = setup();
    await user.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options()[1].id);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(perform.mcp).toHaveBeenCalledTimes(1);
    expect(perform.how).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("fuzzy", () => {
  it("matches ordered subsequences and ranks word starts first", () => {
    expect(fuzzyScore("hiw", "How It Works")).not.toBeNull();
    expect(fuzzyScore("wih", "How It Works")).toBeNull();
    const ranked = fuzzyFilter(["Tool usage", "Tools", "Settings"], "tool", (s) => s);
    expect(ranked).toEqual(["Tools", "Tool usage"]);
    expect(fuzzyFilter(["a", "b"], "  ", (s) => s)).toEqual(["a", "b"]);
  });
});
