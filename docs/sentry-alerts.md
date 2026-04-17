# Sentry Alert Rules — API Error Spikes

This document describes the Sentry alert rules that must be configured in the
Sentry web UI so the team is notified whenever unhandled API errors spike in
production.

---

## Prerequisites

- The API server must be initialised with the `SENTRY_DSN` environment secret
  (set in Replit Secrets and read at startup via `@sentry/node`).
- At least one notification channel (email or Slack) must be connected in
  **Sentry → Project Settings → Integrations**.

---

## Recommended Alert Rules

Configure each rule under **Sentry → Alerts → Create Alert Rule** (choose
**Issues** or **Metric Alerts** as indicated below).

### Rule 1 — Error Rate Spike (Metric Alert)

| Field | Value |
|---|---|
| **Alert type** | Metric Alert |
| **Dataset** | Errors |
| **Metric** | Number of errors in the project |
| **Interval** | 1 minute |
| **Warning threshold** | > 10 errors per minute |
| **Critical threshold** | > 30 errors per minute |
| **Time window** | 5 minutes |
| **Environment** | `production` |
| **Name** | `API — Error Rate Spike` |

**When to fire**: triggers when error count in any 5-minute rolling window
exceeds the threshold. Warning fires a Slack message; Critical fires email +
Slack with high urgency.

---

### Rule 2 — New Unhandled Issue (Issue Alert)

| Field | Value |
|---|---|
| **Alert type** | Issue Alert |
| **Trigger** | A new issue is created |
| **Filter** | Issue category = **Error** |
| **Environment** | `production` |
| **Name** | `API — New Unhandled Issue` |

**When to fire**: fires once, the first time Sentry sees a brand-new error
fingerprint. Good for catching novel crashes immediately without noise from
repeated hits.

---

### Rule 3 — High-Frequency Existing Issue (Issue Alert)

| Field | Value |
|---|---|
| **Alert type** | Issue Alert |
| **Trigger** | The issue is seen more than **N** times |
| **N** | 25 events |
| **Time window** | 1 hour |
| **Filter** | Issue category = **Error** |
| **Environment** | `production` |
| **Name** | `API — Issue Frequency Spike` |

**When to fire**: catches a known (already-seen) issue that suddenly starts
recurring at high volume — e.g. a flapping database connection or a broken
downstream dependency.

---

## Notification Channels

### Email

1. Go to **Sentry → Project Settings → Alerts → Email**.
2. Add all engineers who should receive critical alerts.
3. Assign the email action to Rules 1 (Critical) and 2 above.

### Slack

1. Install the **Sentry** Slack app in your workspace
   (**Sentry → Organization Settings → Integrations → Slack**).
2. Authorise it and choose the target channel (e.g. `#eng-alerts`).
3. Add a **Send a Slack notification** action to all three rules, using the
   `#eng-alerts` channel.

---

## Tuning Guidance

| Signal | Action |
|---|---|
| Too many false positives | Raise the Warning threshold or extend the time window |
| Alerts arrive too late | Lower the Critical threshold or shrink the time window |
| Noise from known non-critical errors | Add a **Filter: Tag `error_type` does not equal `network`** (once the `error_type` tag is applied by the API — see the separate error-tagging task) |

---

## Ownership & Escalation

| Item | Value |
|---|---|
| **Alert owner** | Engineering lead (update when team grows) |
| **Primary on-call channel** | `#eng-alerts` Slack channel |
| **Critical escalation** | Email all engineers listed in Sentry → Project Settings → Alerts → Email |
| **Who maintains thresholds** | Engineering lead reviews thresholds monthly or after any alert-fatigue incident |
| **Threshold review trigger** | > 3 false-positive alerts in a 7-day window → raise Warning/Critical thresholds; < 1 true alert caught in 30 days → lower thresholds |

When an alert fires:
1. Check Sentry for the issue fingerprint and affected release.
2. Resolve or assign the issue in Sentry to silence the alert.
3. If the issue is a known non-critical error class, add a `Filter` to the
   relevant rule so future occurrences are suppressed.

---

## Related Configuration

- **`SENTRY_DSN`** — Replit Secret consumed by `@sentry/node` at API server
  startup.
- **Release tracking** — a separate task wires `SENTRY_RELEASE` / source maps
  so alerts show which deploy introduced an issue.
- **Error-type tags** — a separate task adds a `error_type` tag
  (`network | auth | data`) to every captured event, enabling per-type alert
  filtering once those tags are live.
