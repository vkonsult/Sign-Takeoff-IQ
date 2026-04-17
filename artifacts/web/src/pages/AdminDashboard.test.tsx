import { vi, describe, it, expect } from "vitest";
import React from "react";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axe from "axe-core";

vi.mock("@/components/layout/AdminShell", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

const statsResponse = { organizations: 3, users: 12, jobs: 27 };
const extractionReportResponse = { report: [] };

vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn().mockImplementation((url: string) => {
    if (url.includes("extraction-report")) {
      return Promise.resolve({
        ok: true,
        json: async () => extractionReportResponse,
      });
    }
    if (url.includes("stats")) {
      return Promise.resolve({
        ok: true,
        json: async () => statsResponse,
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }),
}));

vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderAndRunAxe(ui: React.ReactElement) {
  const { container, getByText } = render(
    <QueryClientProvider client={makeClient()}>{ui}</QueryClientProvider>
  );
  await waitFor(() => getByText("Organizations"), { timeout: 5000 });
  const results = await axe.run(container);
  return results;
}

describe("AdminDashboard – accessibility", () => {
  it("has no critical or serious axe violations after data loads", async () => {
    const AdminDashboard = (await import("./AdminDashboard")).default;
    const results = await renderAndRunAxe(<AdminDashboard />);

    const blocking = results.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? "")
    );

    if (blocking.length > 0) {
      const summary = blocking
        .map((v) => `[${v.impact}] ${v.id}: ${v.description}`)
        .join("\n");
      throw new Error(`Accessibility violations found:\n${summary}`);
    }

    expect(blocking).toHaveLength(0);
  });

  it("has no axe violations at all after data loads", async () => {
    const AdminDashboard = (await import("./AdminDashboard")).default;
    const results = await renderAndRunAxe(<AdminDashboard />);

    if (results.violations.length > 0) {
      const summary = results.violations
        .map((v) => `[${v.impact}] ${v.id}: ${v.description}`)
        .join("\n");
      throw new Error(`Accessibility violations found:\n${summary}`);
    }

    expect(results.violations).toHaveLength(0);
  });
});
