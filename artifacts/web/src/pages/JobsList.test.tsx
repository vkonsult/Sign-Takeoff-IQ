// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import axe from "axe-core";
import React from "react";

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/jobs", vi.fn()],
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-takeoff", () => ({
  useJobsList: () => ({
    data: {
      jobs: [
        {
          id: "job-abc-001",
          name: "Alpha Project",
          status: "completed",
          createdAt: "2024-01-15T10:00:00.000Z",
          updatedAt: "2024-01-16T12:00:00.000Z",
          recentUsers: [],
          files: [],
          plaqueCount: 2,
          occupantLoadCount: 0,
          unplacedCount: 0,
        },
        {
          id: "job-def-002",
          name: "Beta Project",
          status: "processing",
          createdAt: "2024-01-14T08:00:00.000Z",
          updatedAt: null,
          recentUsers: [],
          files: [],
          plaqueCount: 0,
          occupantLoadCount: 1,
          unplacedCount: 2,
        },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
  openPdfInNewTab: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListJobsQueryKey: () => ["jobs"],
}));

vi.mock("@/components/layout/Shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      "div",
      { className: "app-shell" },
      React.createElement(
        "nav",
        { "aria-label": "Main navigation" },
        React.createElement("a", { href: "/" }, "Home"),
        React.createElement("a", { href: "/jobs" }, "All Jobs"),
      ),
      React.createElement("main", null, children),
    ),
}));

import JobsList from "./JobsList";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("JobsList – axe accessibility", () => {
  it("has no axe violations on initial render", async () => {
    const { container } = render(React.createElement(JobsList));
    const results = await axe.run(container);
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.description}`).join("\n"),
    ).toHaveLength(0);
  });
});

describe("JobsList – landmark structure", () => {
  it("renders a main landmark via the shell", () => {
    const { container } = render(React.createElement(JobsList));
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
  });

  it("renders a nav landmark via the shell", () => {
    const { container } = render(React.createElement(JobsList));
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
  });

  it("nav landmark has an accessible name (aria-label)", () => {
    const { container } = render(React.createElement(JobsList));
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute("aria-label")).toBeTruthy();
  });

  it("renders an h1 heading", () => {
    const { container } = render(React.createElement(JobsList));
    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it("h1 is the first heading (no h2 before h1)", () => {
    const { container } = render(React.createElement(JobsList));
    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    if (headings.length > 0) {
      expect(headings[0].tagName.toLowerCase()).toBe("h1");
    }
  });
});

describe("JobsList – interactive controls accessibility", () => {
  it("select-all button has a title attribute", () => {
    const { container } = render(React.createElement(JobsList));
    const buttons = Array.from(container.querySelectorAll("button"));
    const selectAll = buttons.find(
      (b) =>
        b.getAttribute("title") === "Select all" ||
        b.getAttribute("title") === "Deselect all",
    );
    expect(selectAll, "select-all button with title should exist").not.toBeUndefined();
  });

  it("sort header buttons contain visible text labels", () => {
    const { container } = render(React.createElement(JobsList));
    const buttons = Array.from(container.querySelectorAll("button"));
    const sortButtons = buttons.filter((b) =>
      ["Job Name", "Status", "Created", "Updated"].some((label) =>
        b.textContent!.includes(label),
      ),
    );
    expect(sortButtons.length).toBeGreaterThan(0);
    for (const btn of sortButtons) {
      expect(
        btn.textContent!.trim().length,
        `sort button "${btn.textContent}" must have visible text`,
      ).toBeGreaterThan(0);
    }
  });

  it("job row links have href attributes pointing to job detail pages", () => {
    const { container } = render(React.createElement(JobsList));
    const links = Array.from(container.querySelectorAll("a[href]"));
    const jobLinks = links.filter((a) =>
      a.getAttribute("href")?.startsWith("/jobs/"),
    );
    expect(jobLinks.length).toBe(2);
    for (const link of jobLinks) {
      expect(link.getAttribute("href")).toMatch(/^\/jobs\/.+/);
    }
  });

  it("delete buttons have title attributes for screen readers", () => {
    const { container } = render(React.createElement(JobsList));
    const deleteButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.getAttribute("title") === "Delete this job",
    );
    expect(deleteButtons.length).toBe(2);
  });
});
