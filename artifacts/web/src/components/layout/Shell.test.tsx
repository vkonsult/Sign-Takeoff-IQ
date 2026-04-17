import { vi, describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import axe from "axe-core";
import type { AppRole } from "@/hooks/use-user-role";
import { AppShell } from "./Shell";
import { Sidebar } from "./Sidebar";

const mockUseUserRole = vi.fn();

vi.mock("@/hooks/use-user-role", () => ({
  useUserRole: () => mockUseUserRole(),
}));

vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: null, isLoaded: true }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

vi.mock("@/lib/apiClient", () => ({
  isGuestMode: () => false,
  clearGuestToken: vi.fn(),
}));

vi.mock("@/hooks/use-takeoff", () => ({
  useJobsList: () => ({ data: { jobs: [], recentActivity: [] }, isLoading: false }),
}));

function makeRole(
  role: AppRole,
  { isAdmin = false, isSuperAdmin = false } = {}
) {
  return {
    role,
    organizationId: "org-1",
    isLoaded: true,
    isAdmin,
    isSuperAdmin,
  };
}

async function runAxeOn(container: HTMLElement) {
  const results = await axe.run(container);
  return results.violations.filter((v) => v.id === "landmark-unique");
}

function renderShell() {
  const loc = memoryLocation({ path: "/jobs", record: true });
  return render(
    <Router hook={loc.hook}>
      <AppShell>
        <div>page content</div>
      </AppShell>
    </Router>
  );
}

function renderSidebar(collapsed: boolean) {
  const loc = memoryLocation({ path: "/jobs", record: true });
  return render(
    <Router hook={loc.hook}>
      <Sidebar collapsed={collapsed} onToggle={vi.fn()} />
    </Router>
  );
}

describe("AppShell landmark accessibility", () => {
  beforeEach(() => {
    mockUseUserRole.mockReset();
  });

  it("passes axe landmark-unique check for a plain Estimator (no extra nav sections)", async () => {
    mockUseUserRole.mockReturnValue(makeRole("ESTIMATOR"));

    const { container } = renderShell();
    const violations = await runAxeOn(container);
    expect(violations).toHaveLength(0);
  });

  it("passes axe landmark-unique check when the admin Settings nav section is visible", async () => {
    mockUseUserRole.mockReturnValue(makeRole("ADMIN", { isAdmin: true }));

    const { container } = renderShell();
    const violations = await runAxeOn(container);
    expect(violations).toHaveLength(0);
  });

  it("passes axe landmark-unique check when the super-admin nav section is visible", async () => {
    mockUseUserRole.mockReturnValue(
      makeRole("SUPER_ADMIN", { isAdmin: true, isSuperAdmin: true })
    );

    const { container } = renderShell();
    const violations = await runAxeOn(container);
    expect(violations).toHaveLength(0);
  });
});

describe("Sidebar collapsed state — accessibility", () => {
  beforeEach(() => {
    mockUseUserRole.mockReset();
    mockUseUserRole.mockReturnValue(makeRole("ESTIMATOR"));
  });

  it("renders collapsed sidebar without critical axe violations", async () => {
    const { container } = renderSidebar(true);
    const results = await axe.run(container);
    const criticalViolations = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );
    expect(
      criticalViolations,
      `axe found ${criticalViolations.length} critical/serious violation(s):\n` +
        criticalViolations
          .map((v) => `  [${v.id}] ${v.description}`)
          .join("\n")
    ).toHaveLength(0);
  });

  it("all icon-only nav links have an accessible name in collapsed mode", () => {
    const { container } = renderSidebar(true);
    const links = container.querySelectorAll("a[href]");
    expect(links.length).toBeGreaterThan(0);
    links.forEach((link) => {
      const ariaLabel = link.getAttribute("aria-label");
      const title = link.getAttribute("title");
      const textContent = (link.textContent ?? "").trim();
      const hasAccessibleName = !!(ariaLabel || title || textContent);
      expect(
        hasAccessibleName,
        `Link to "${link.getAttribute("href")}" is missing an accessible name`
      ).toBe(true);
    });
  });

  it("sign-out button has an accessible name in collapsed mode", () => {
    const { container } = renderSidebar(true);
    const signOutButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => {
        const label = (btn.getAttribute("aria-label") ?? "").toLowerCase();
        return label.includes("sign out") || label.includes("exit guest");
      }
    );
    expect(signOutButton).toBeTruthy();
    expect(signOutButton?.getAttribute("aria-label")).toBeTruthy();
  });

  it("expand sidebar button has an accessible name in collapsed mode", () => {
    const { container } = renderSidebar(true);
    const expandButton = Array.from(container.querySelectorAll("button")).find(
      (btn) =>
        (btn.getAttribute("aria-label") ?? "").toLowerCase().includes("expand")
    );
    expect(expandButton).toBeTruthy();
    expect(expandButton?.getAttribute("aria-label")).toBe("Expand sidebar");
  });

  it("renders expanded sidebar without critical axe violations (baseline)", async () => {
    const { container } = renderSidebar(false);
    const results = await axe.run(container);
    const criticalViolations = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );
    expect(
      criticalViolations,
      `axe found ${criticalViolations.length} critical/serious violation(s):\n` +
        criticalViolations
          .map((v) => `  [${v.id}] ${v.description}`)
          .join("\n")
    ).toHaveLength(0);
  });
});
