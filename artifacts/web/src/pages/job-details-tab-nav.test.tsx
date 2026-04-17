import { vi, describe, it, expect } from "vitest";
import React from "react";
import { render, screen, act } from "@testing-library/react";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/layout/Shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/UnifiedPlanViewer", () => ({ UnifiedPlanViewer: () => null }));
vi.mock("@/components/SignSpecModal", () => ({ SignSpecModal: () => null }));
vi.mock("@/components/AiScansTab", () => ({ AiScansTab: () => null }));
vi.mock("@/components/SignSpecsTab", () => ({ SignSpecsTab: () => null }));
vi.mock("@/lib/exportMarkedupPdf", () => ({ exportMarkedupPdf: vi.fn() }));
vi.mock("@/lib/exportVerificationPdf", () => ({ exportVerificationPdf: vi.fn() }));

vi.mock("@/lib/apiClient", () => ({
  isGuestMode: () => true,
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  openPdfInNewTab: vi.fn(),
}));

vi.mock("@/hooks/use-takeoff", () => ({
  useJobDetails: () => ({
    data: {
      job: {
        id: "test-job-123",
        name: "Test Job",
        status: "completed",
        createdAt: new Date().toISOString(),
        processingLog: [],
        inputTokens: 0,
        outputTokens: 0,
      },
      files: [],
      extractedSigns: [],
      totalSigns: 0,
      flaggedCount: 0,
      highConfidenceCount: 0,
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
  useStartExtraction: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryFile: () => ({ mutate: vi.fn(), isPending: false }),
  downloadExport: vi.fn(),
  useUpdateJobName: () => vi.fn().mockResolvedValue({}),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetJobQueryKey: (id: string) => ["job", id],
}));

import { parseTabParam, VALID_TAB_NAMES } from "@/lib/tab-param";
import JobDetails from "./JobDetails";

// ── parseTabParam unit tests ────────────────────────────────────────────────

describe("parseTabParam", () => {
  it("returns null for empty search string", () => {
    expect(parseTabParam("")).toBeNull();
  });

  it("returns null when tab param is absent", () => {
    expect(parseTabParam("?other=value")).toBeNull();
  });

  it("returns null for unknown tab names", () => {
    expect(parseTabParam("?tab=unknown")).toBeNull();
    expect(parseTabParam("?tab=")).toBeNull();
  });

  it("maps the legacy 'signs' alias to 'table'", () => {
    expect(parseTabParam("?tab=signs")).toBe("table");
  });

  it.each([...VALID_TAB_NAMES])("recognises valid tab '%s'", (tab) => {
    expect(parseTabParam(`?tab=${tab}`)).toBe(tab);
  });
});

// ── Test harness ─────────────────────────────────────────────────────────────

function renderJobDetails(initialPath: string) {
  const loc = memoryLocation({ path: initialPath, record: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={loc.hook}>
        <Route path="/jobs/:jobId">{() => <JobDetails />}</Route>
      </Router>
    </QueryClientProvider>
  );

  // navStack mirrors what the browser's history stack would look like
  const navStack: string[] = [initialPath];
  let stackPointer = 0;

  function clickTab(label: string) {
    const before = loc.history!.length;
    act(() => {
      const btn = screen.getAllByRole("button").find(
        (b) => b.textContent?.trim().toLowerCase() === label.toLowerCase()
      );
      if (!btn) throw new Error(`Tab "${label}" not found`);
      btn.click();
    });
    // Only update stack if the component actually navigated
    if (loc.history!.length > before) {
      navStack.splice(stackPointer + 1);
      navStack.push(loc.history!.at(-1)!);
      stackPointer = navStack.length - 1;
    }
  }

  function back() {
    if (stackPointer <= 0) return;
    stackPointer -= 1;
    act(() => {
      loc.navigate(navStack[stackPointer]);
    });
  }

  // Authoritative current URL: the last entry in the router's recorded history
  function currentUrl() {
    return loc.history!.at(-1) ?? initialPath;
  }

  // The tab button in the tab bar that is currently highlighted (border-b-2 border-primary)
  function activeTabLabel() {
    const btn = screen.queryAllByRole("button").find((b) => {
      const cls = b.getAttribute("class") ?? "";
      return cls.includes("border-b-2") && cls.includes("border-primary");
    });
    return btn?.textContent?.trim() ?? null;
  }

  return { loc, clickTab, back, currentUrl, activeTabLabel };
}

// ── Integration tests: tab URL sync (real JobDetails component) ───────────────

describe("JobDetails tab URL sync", () => {
  it("clicking 'Sheets Analysis' updates the URL to ?tab=sheets", () => {
    const { clickTab, currentUrl } = renderJobDetails("/jobs/test-job-123");
    clickTab("Sheets Analysis");
    expect(currentUrl()).toContain("tab=sheets");
  });

  it("clicking 'Sign Type Summary' updates the URL to ?tab=summary", () => {
    const { clickTab, currentUrl } = renderJobDetails("/jobs/test-job-123");
    clickTab("Sign Type Summary");
    expect(currentUrl()).toContain("tab=summary");
  });

  it("clicking 'Timeline' updates the URL to ?tab=timeline", () => {
    const { clickTab, currentUrl } = renderJobDetails("/jobs/test-job-123");
    clickTab("Timeline");
    expect(currentUrl()).toContain("tab=timeline");
  });

  it("each tab click pushes a separate history entry", () => {
    const { clickTab, loc } = renderJobDetails("/jobs/test-job-123");
    const before = loc.history!.length;
    clickTab("Sheets Analysis");
    clickTab("Sign Type Summary");
    clickTab("Timeline");
    expect(loc.history!.length).toBe(before + 3);
  });

  it("direct navigation to ?tab=timeline pre-selects the Timeline tab", () => {
    const { activeTabLabel } = renderJobDetails("/jobs/test-job-123?tab=timeline");
    expect(activeTabLabel()).toContain("Timeline");
  });

  it("direct navigation to ?tab=summary pre-selects the Sign Type Summary tab", () => {
    const { activeTabLabel } = renderJobDetails("/jobs/test-job-123?tab=summary");
    expect(activeTabLabel()).toContain("Sign Type Summary");
  });
});

// ── Integration tests: back-button behavior ───────────────────────────────────

describe("JobDetails back-button behavior", () => {
  it("back one step restores the previous tab and URL", () => {
    const { clickTab, back, currentUrl, activeTabLabel } = renderJobDetails("/jobs/test-job-123");
    clickTab("Sheets Analysis");
    clickTab("Sign Type Summary");
    back();
    expect(currentUrl()).toContain("tab=sheets");
    expect(activeTabLabel()).toContain("Sheets Analysis");
  });

  it("back two steps restores each intermediate tab in order", () => {
    const { clickTab, back, currentUrl, activeTabLabel } = renderJobDetails("/jobs/test-job-123");
    clickTab("Sheets Analysis");
    clickTab("Sign Type Summary");
    clickTab("Timeline");
    back();
    expect(currentUrl()).toContain("tab=summary");
    expect(activeTabLabel()).toContain("Sign Type Summary");
    back();
    expect(currentUrl()).toContain("tab=sheets");
    expect(activeTabLabel()).toContain("Sheets Analysis");
  });

  it("back to initial URL (no ?tab=) restores the Sign Table tab", () => {
    const { clickTab, back, currentUrl, activeTabLabel } = renderJobDetails("/jobs/test-job-123");
    clickTab("Sheets Analysis");
    clickTab("Sign Type Summary");
    clickTab("Timeline");
    back(); // → summary
    back(); // → sheets
    back(); // → initial
    expect(currentUrl()).not.toContain("tab=");
    expect(activeTabLabel()).toContain("Sign Table");
  });

  it("full forward + backward cycle through multiple tabs restores each tab", () => {
    const { clickTab, back, currentUrl, activeTabLabel } = renderJobDetails("/jobs/test-job-123");
    const sequence = [
      { label: "Sheets Analysis", param: "sheets" },
      { label: "Sign Type Summary", param: "summary" },
      { label: "Sign Specs", param: "specs" },
      { label: "Timeline", param: "timeline" },
    ];
    for (const { label } of sequence) {
      clickTab(label);
    }
    for (let i = sequence.length - 2; i >= 0; i--) {
      back();
      expect(currentUrl()).toContain(`tab=${sequence[i].param}`);
      expect(activeTabLabel()).toContain(sequence[i].label);
    }
    back();
    expect(currentUrl()).not.toContain("tab=");
    expect(activeTabLabel()).toContain("Sign Table");
  });
});
