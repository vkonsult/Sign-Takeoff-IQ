// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import axe from "axe-core";
import React from "react";

// vi.hoisted variables are evaluated before vi.mock factory closures.
// This lets the factory read `searchState.value` without hoisting issues.
const searchState = vi.hoisted(() => ({ value: "" }));

vi.mock("wouter", () => ({
  useRoute: () => [true, { jobId: "test-job-id" }],
  useSearch: () => searchState.value,
  useLocation: () => [
    `/jobs/test-job-id${searchState.value}`,
    (path: string) => {
      const qs = path.split("?")[1] ?? "";
      searchState.value = qs ? `?${qs}` : "";
    },
  ],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-takeoff", () => ({
  useJobDetails: () => ({
    data: {
      job: {
        id: "test-job-id",
        name: "Test Job",
        status: "completed",
        createdAt: "2024-01-01T00:00:00.000Z",
        projectAddress: null,
        projectCity: null,
        projectState: null,
        inputTokens: 0,
        outputTokens: 0,
        error: null,
      },
      files: [],
      extractedSigns: [],
      hiddenSigns: [],
      markerSigns: [],
      totalSigns: 0,
      flaggedCount: 0,
      highConfidenceCount: 0,
      plaqueCount: 0,
      occupantLoadCount: 0,
      lastScan: null,
      lastEdit: null,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useStartExtraction: () => ({ mutate: vi.fn(), isPending: false }),
  downloadExport: vi.fn().mockResolvedValue({ signCount: 0 }),
  useUpdateJobName: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useExportButtonState", () => ({
  useExportButtonState: () => ({
    pdf: { disabled: true, tooltip: "No markers placed", showBadge: false },
    xlsx: { disabled: true, tooltip: "No signs found", showBadge: false },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  openPdfInNewTab: vi.fn(),
}));

vi.mock("@/lib/exportMarkedupPdf", () => ({
  exportMarkedupPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/layout/Shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("main", { "data-testid": "shell" }, children),
}));

vi.mock("@/components/UnifiedPlanViewer", () => ({
  UnifiedPlanViewer: () =>
    React.createElement("div", { "data-testid": "plan-viewer" }),
}));

vi.mock("@/components/SignSpecModal", () => ({
  SignSpecModal: () => null,
}));

vi.mock("@/components/AiScansTab", () => ({
  AiScansTab: () => React.createElement("div", { "data-testid": "ai-scans-tab" }),
}));

vi.mock("@/components/SignSpecsTab", () => ({
  SignSpecsTab: () => React.createElement("div", { "data-testid": "sign-specs-tab" }),
}));

vi.mock("@/components/ComplianceTab", () => ({
  ComplianceTab: () => React.createElement("div", { "data-testid": "compliance-tab" }),
}));

vi.mock("@/hooks/use-user-role", () => ({
  useUserRole: () => ({
    role: "ADMIN",
    organizationId: "test-org",
    isLoaded: true,
    isSuperAdmin: false,
    isAdmin: true,
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetJobQueryKey: (jobId: string) => ["jobs", jobId],
  useGetPlaqueSchedule: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useGetOccupantLoads: () => ({
    data: { loads: [], assemblyRooms: [] },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useExtractPlaqueSchedule: () => ({ mutate: vi.fn(), isPending: false }),
  useExtractOccupantLoads: () => ({ mutate: vi.fn(), isPending: false }),
}));

import JobDetails from "./JobDetails";

const ALWAYS_VISIBLE_TABS = [
  "table",
  "sheets",
  "summary",
  "floorplans",
  "signpages",
  "specs",
  "timeline",
] as const;

const CONDITIONAL_TABS = [
  "coords",
  "ai_scans",
  "compliance",
  "plaque_schedule",
  "occupant_loads",
] as const;

type TabId = (typeof ALWAYS_VISIBLE_TABS)[number] | (typeof CONDITIONAL_TABS)[number];

const ALL_TABS: TabId[] = [...ALWAYS_VISIBLE_TABS, ...CONDITIONAL_TABS];

beforeEach(() => {
  searchState.value = "";
});
afterEach(cleanup);

// Render JobDetails with a specific tab active (set via URL query param mock).
function renderWithTab(tabId: TabId) {
  searchState.value = `?tab=${tabId}`;
  return render(React.createElement(JobDetails));
}

describe("JobDetails – tab widget ARIA", () => {
  it("has no axe violations on initial render (table tab active)", async () => {
    const { container } = render(React.createElement(JobDetails));
    const results = await axe.run(container);
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.description}`).join("\n"),
    ).toHaveLength(0);
  });

  it("renders one tablist with an aria-label", () => {
    const { container } = render(React.createElement(JobDetails));
    const tl = container.querySelectorAll('[role="tablist"]');
    expect(tl).toHaveLength(1);
    expect(tl[0].getAttribute("aria-label")).toBeTruthy();
  });

  it("all always-visible tab ids are present", () => {
    const { container } = render(React.createElement(JobDetails));
    for (const id of ALWAYS_VISIBLE_TABS) {
      expect(container.querySelector(`#tab-${id}`), `tab-${id}`).not.toBeNull();
    }
  });

  it("all conditional tabs are present when job is completed", () => {
    const { container } = render(React.createElement(JobDetails));
    for (const id of CONDITIONAL_TABS) {
      expect(container.querySelector(`#tab-${id}`), `tab-${id}`).not.toBeNull();
    }
  });

  it("every tab element has role='tab'", () => {
    const { container } = render(React.createElement(JobDetails));
    for (const id of ALL_TABS) {
      expect(container.querySelector(`#tab-${id}`)?.getAttribute("role"), `tab-${id}`).toBe("tab");
    }
  });

  it("exactly one tab is aria-selected=true on load; all others are false", () => {
    const { container } = render(React.createElement(JobDetails));
    const tabs = container.querySelectorAll('[role="tab"]');
    const selected = Array.from(tabs).filter((t) => t.getAttribute("aria-selected") === "true");
    const unselected = Array.from(tabs).filter((t) => t.getAttribute("aria-selected") !== "true");
    expect(selected).toHaveLength(1);
    for (const tab of unselected) {
      expect(tab.getAttribute("aria-selected")).toBe("false");
    }
  });

  it("active tab has tabIndex=0; all others have tabIndex=-1 (roving tabIndex)", () => {
    const { container } = render(React.createElement(JobDetails));
    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
    let zeros = 0;
    for (const tab of tabs) {
      if (tab.tabIndex === 0) {
        zeros++;
        expect(tab.getAttribute("aria-selected")).toBe("true");
      } else {
        expect(tab.tabIndex).toBe(-1);
      }
    }
    expect(zeros).toBe(1);
  });

  it("each tab's aria-controls is tabpanel-{tabId}", () => {
    const { container } = render(React.createElement(JobDetails));
    for (const id of ALL_TABS) {
      const tab = container.querySelector(`#tab-${id}`)!;
      expect(tab.getAttribute("aria-controls"), `tab-${id}`).toBe(`tabpanel-${id}`);
    }
  });

  // For each tab, render with that tab active and assert the ARIA triangle:
  // tab[aria-selected=true, aria-controls=X] ↔ panel[id=X, aria-labelledby=tab]
  describe.each(ALL_TABS)("ARIA triangle for tab '%s' when active", (tabId) => {
    it("renders exactly one tabpanel", () => {
      const { container } = renderWithTab(tabId);
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    });

    it("active panel id is tabpanel-{tabId}", () => {
      const { container } = renderWithTab(tabId);
      expect(container.querySelector('[role="tabpanel"]')!.id).toBe(`tabpanel-${tabId}`);
    });

    it("active panel aria-labelledby points to this tab", () => {
      const { container } = renderWithTab(tabId);
      expect(container.querySelector('[role="tabpanel"]')!.getAttribute("aria-labelledby")).toBe(`tab-${tabId}`);
    });

    it("tab aria-controls resolves to the rendered panel", () => {
      const { container } = renderWithTab(tabId);
      const tab = container.querySelector(`#tab-${tabId}`)!;
      const panelId = tab.getAttribute("aria-controls")!;
      const panel = container.querySelector(`#${panelId}`);
      expect(panel, `#${panelId} must exist`).not.toBeNull();
      expect(panel!.getAttribute("role")).toBe("tabpanel");
    });

    it("this tab is aria-selected=true; all others are false", () => {
      const { container } = renderWithTab(tabId);
      expect(container.querySelector(`#tab-${tabId}`)!.getAttribute("aria-selected")).toBe("true");
      const others = Array.from(container.querySelectorAll('[role="tab"]')).filter(
        (t) => t.id !== `tab-${tabId}`,
      );
      for (const t of others) {
        expect(t.getAttribute("aria-selected"), `${t.id} should not be selected`).toBe("false");
      }
    });
  });
});
