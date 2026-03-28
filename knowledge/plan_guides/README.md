# Plan Reading Guides Knowledge Base

This directory contains guides and references for reading architectural plans, sign schedules, and construction documents in the sign industry.

## Expected File Format

Files should be Markdown (`.md`) or plain text (`.txt`) with YAML front-matter metadata:

```markdown
---
jurisdiction: universal
doc_type: plan_guides
section: "Sign Schedules"
effective_date: "2024-01-01"
status: active
---

## Reading Sign Schedules

A sign schedule is a table in architectural drawings that lists all signs for a project...
```

## Required Metadata Fields

| Field | Description | Example |
|-------|-------------|---------|
| `jurisdiction` | Use `universal` for general guides | `universal` |
| `doc_type` | Always `plan_guides` for this directory | `plan_guides` |
| `section` | Topic area | `Sign Schedules`, `Drawing Conventions`, `Callouts` |
| `effective_date` | Date this guide was created/updated | `2024-01-01` |
| `status` | One of: `active`, `superseded`, `draft` | `active` |

## Suggested Guide Topics

- `sign_schedule_formats.md` — Common sign schedule table formats and column meanings
- `drawing_conventions.md` — Standard architectural drawing symbols, scale conventions
- `callout_types.md` — Understanding detail callouts, sheet references, revision clouds
- `specification_sections.md` — CSI MasterFormat sections relevant to signs (10 14 00, 10 22 00)
- `submittal_process.md` — Shop drawing submittal workflow and approval stages
- `takeoff_methodology.md` — Best practices for counting and quantifying signs from plans

## TODO

- [ ] Create guide for reading common sign schedule formats
- [ ] Document standard callout and detail reference conventions
- [ ] Add guide for CSI specification sections for signs (Division 10)
- [ ] Document how to handle revision sheets in plan takeoffs
- [ ] Add guide for electronic plan (PDF layer) navigation tips
