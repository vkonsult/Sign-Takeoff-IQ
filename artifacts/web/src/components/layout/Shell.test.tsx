import { vi, describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import axe from "axe-core";
import type { AppRole } from "@/hooks/use-user-role";
import { AppShell } from "./Shell";

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
