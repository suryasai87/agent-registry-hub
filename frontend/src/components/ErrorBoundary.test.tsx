import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/utils";
import ErrorBoundary from "./ErrorBoundary";
import Shell from "./Shell";

let shouldThrow = true;
function Boom() {
  if (shouldThrow) throw new Error("kaboom: registry row missing");
  return <p>recovered content</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    shouldThrow = true;
    vi.spyOn(console, "error").mockImplementation(() => {}); // React reports caught render errors
  });

  it("catches a throwing child, shows the message and retries", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ErrorBoundary name="Catalog">
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong in “Catalog”");
    expect(alert).toHaveTextContent("kaboom: registry row missing");

    shouldThrow = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("recovered content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resets when the resetKey (the route) changes", () => {
    const { rerender } = renderWithProviders(
      <ErrorBoundary resetKey="/a">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    shouldThrow = false;
    rerender(
      <ErrorBoundary resetKey="/b">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("recovered content")).toBeInTheDocument();
  });

  it("contains a throwing page inside the shell instead of blanking the app", () => {
    renderWithProviders(
      <Shell>
        <ErrorBoundary name="Broken page">
          <Boom />
        </ErrorBoundary>
      </Shell>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Broken page");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("Agent Registry Hub")).toBeInTheDocument();
  });
});
