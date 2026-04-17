// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import axe from "axe-core";
import React from "react";

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
  Link: ({
    href,
    children,
    className,
    "aria-label": ariaLabel,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => React.createElement("a", { href, className, "aria-label": ariaLabel }, children),
}));

vi.mock("@/hooks/use-takeoff", () => ({
  useJobsList: () => ({ data: { jobs: [] }, isLoading: false }),
}));

vi.mock("@clerk/react", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useUser: () => ({ user: { firstName: "Jane", lastName: "Doe", fullName: "Jane Doe", emailAddresses: [] } }),
}));

vi.mock("@/hooks/use-user-role", () => ({
  useUserRole: () => ({ role: "ESTIMATOR", isAdmin: false, isSuperAdmin: false }),
}));

vi.mock("@/lib/apiClient", () => ({
  isGuestMode: () => false,
  clearGuestToken: vi.fn(),
}));

import { AppShell } from "./Shell";

afterEach(cleanup);

describe("AppShell – landmark structure", () => {
  it("has no axe violations with child content", async () => {
    const { container } = render(
      React.createElement(
        AppShell,
        null,
        React.createElement("h1", null, "Page Title"),
        React.createElement("p", null, "Page content goes here."),
      ),
    );
    const results = await axe.run(container);
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.description}`).join("\n"),
    ).toHaveLength(0);
  });

  it("renders exactly one main landmark", () => {
    const { container } = render(
      React.createElement(AppShell, null, React.createElement("p", null, "content")),
    );
    const mains = container.querySelectorAll("main");
    expect(mains).toHaveLength(1);
  });

  it("renders at least one nav landmark", () => {
    const { container } = render(
      React.createElement(AppShell, null, React.createElement("p", null, "content")),
    );
    const navs = container.querySelectorAll("nav");
    expect(navs.length).toBeGreaterThanOrEqual(1);
  });

  it("nav landmark has an accessible name (aria-label)", () => {
    const { container } = render(
      React.createElement(AppShell, null, React.createElement("p", null, "content")),
    );
    const navs = Array.from(container.querySelectorAll("nav"));
    const labeledNavs = navs.filter((nav) => nav.getAttribute("aria-label"));
    expect(
      labeledNavs.length,
      "At least one nav should have an aria-label",
    ).toBeGreaterThanOrEqual(1);
  });

  it("children are rendered inside the main landmark", () => {
    const { container } = render(
      React.createElement(
        AppShell,
        null,
        React.createElement("p", { id: "test-child" }, "child content"),
      ),
    );
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(main!.querySelector("#test-child")).not.toBeNull();
  });

  it("sidebar nav links have text content", () => {
    const { container } = render(
      React.createElement(AppShell, null, React.createElement("p", null, "content")),
    );
    const navLinks = Array.from(container.querySelectorAll("nav a"));
    expect(navLinks.length).toBeGreaterThan(0);
    for (const link of navLinks) {
      expect(
        link.textContent!.trim().length,
        `nav link "${link.getAttribute("href")}" must have visible text`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("AppShell – collapsed state landmarks", () => {
  it("has no axe violations when sidebar is collapsed", async () => {
    const TestComponent = () => {
      const [collapsed, setCollapsed] = React.useState(true);
      void collapsed;
      void setCollapsed;
      return React.createElement(
        AppShell,
        null,
        React.createElement("h1", null, "Test Page"),
      );
    };

    localStorage.setItem("sidebar-collapsed", "true");

    const { container } = render(React.createElement(TestComponent));
    const results = await axe.run(container);
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.description}`).join("\n"),
    ).toHaveLength(0);

    localStorage.removeItem("sidebar-collapsed");
  });

  it("still renders main and nav in collapsed state", () => {
    localStorage.setItem("sidebar-collapsed", "true");
    const { container } = render(
      React.createElement(AppShell, null, React.createElement("p", null, "content")),
    );
    expect(container.querySelector("main")).not.toBeNull();
    expect(container.querySelector("nav")).not.toBeNull();
    localStorage.removeItem("sidebar-collapsed");
  });
});
