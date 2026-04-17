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

const mockOrg = {
  id: "org-1",
  name: "Acme Signs",
  slug: "acme",
  email: "hello@acme.com",
  phone: "555-1234",
  address: "123 Main St",
  website: "https://acme.com",
  logoUrl: null,
  onboardingComplete: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ organization: mockOrg }),
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderAndRunAxe(ui: React.ReactElement) {
  const { container, getByDisplayValue } = render(
    <QueryClientProvider client={makeClient()}>{ui}</QueryClientProvider>
  );
  await waitFor(() => getByDisplayValue(mockOrg.name), { timeout: 5000 });
  const results = await axe.run(container);
  return results;
}

describe("SettingsCompany – accessibility", () => {
  it("has no critical or serious axe violations after data loads", async () => {
    const SettingsCompany = (await import("./SettingsCompany")).default;
    const results = await renderAndRunAxe(<SettingsCompany />);

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
    const SettingsCompany = (await import("./SettingsCompany")).default;
    const results = await renderAndRunAxe(<SettingsCompany />);

    if (results.violations.length > 0) {
      const summary = results.violations
        .map((v) => `[${v.impact}] ${v.id}: ${v.description}`)
        .join("\n");
      throw new Error(`Accessibility violations found:\n${summary}`);
    }

    expect(results.violations).toHaveLength(0);
  });
});
