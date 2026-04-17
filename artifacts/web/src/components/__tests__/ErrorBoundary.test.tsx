// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
});

function Boom(): React.ReactElement {
  throw new Error("test crash");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(getByText("all good")).toBeTruthy();
  });

  it("renders the error card heading when a child throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("renders the generic error message when no routeName is provided", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/This page ran into an unexpected error/i)).toBeTruthy();
    expect(screen.getByText(/The rest of the app is still available/i)).toBeTruthy();
    consoleError.mockRestore();
  });

  it("includes the routeName in the error message when provided", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary routeName="Jobs">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/The Jobs page ran into an unexpected error/i)).toBeTruthy();
    consoleError.mockRestore();
  });

  it("renders Try again and Go back action buttons", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /go back/i })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("resets to children after clicking Try again", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function MaybeThrow() {
      if (shouldThrow) throw new Error("boom");
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary>
        <MaybeThrow />
      </ErrorBoundary>
    );
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("recovered")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("nav links outside the boundary remain accessible after a crash", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <nav>
          <a href="/jobs">Jobs</a>
          <a href="/training">Training</a>
        </nav>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </div>
    );

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();

    const jobsLink = screen.getByRole("link", { name: "Jobs" });
    const trainingLink = screen.getByRole("link", { name: "Training" });
    expect(jobsLink).toBeTruthy();
    expect(trainingLink).toBeTruthy();
    expect((jobsLink as HTMLAnchorElement).href).toContain("/jobs");
    expect((trainingLink as HTMLAnchorElement).href).toContain("/training");
    consoleError.mockRestore();
  });

  it("nav element is not removed from the DOM after a crash", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <div>
        <nav aria-label="main-nav">
          <a href="/jobs">Jobs</a>
        </nav>
        <main>
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        </main>
      </div>
    );

    const nav = container.querySelector("nav[aria-label='main-nav']");
    expect(nav).toBeTruthy();
    expect(nav!.querySelector("a")).toBeTruthy();
    consoleError.mockRestore();
  });
});
