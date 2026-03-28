# Federal Codes Knowledge Base

This directory contains federal sign regulations and standards for use in RAG-assisted sign takeoff.

## Expected File Format

Files should be Markdown (`.md`) or plain text (`.txt`) with YAML front-matter metadata:

```markdown
---
jurisdiction: federal
doc_type: federal_codes
section: "ADA 703.7.2"
effective_date: "2010-09-15"
status: active
---

Content of the sign regulation or standard...
```

## Required Metadata Fields

| Field | Description | Example |
|-------|-------------|---------|
| `jurisdiction` | Always `federal` for this directory | `federal` |
| `doc_type` | Always `federal_codes` for this directory | `federal_codes` |
| `section` | Standard or code section reference | `ADA 703.7.2`, `MUTCD 2A.01` |
| `effective_date` | Date regulation took effect (ISO 8601) | `2010-09-15` |
| `status` | One of: `active`, `superseded`, `draft` | `active` |

## Content Guidelines

- Split long documents into logical sections — one section per file or one section per heading
- Prefer specific, concrete regulatory language over paraphrasing
- Include measurement requirements, tolerances, and material specifications where applicable
- Note any exceptions or AHJ (Authority Having Jurisdiction) discretion clauses

## Suggested Sources

- ADA Standards for Accessible Design (2010)
- Manual on Uniform Traffic Control Devices (MUTCD) — latest edition
- OSHA signage requirements (29 CFR 1910.145)
- International Building Code (IBC) signage sections
- NFPA 101 Life Safety Code — exit sign requirements
- UL 924 — Emergency Lighting and Power Equipment

## TODO

- [ ] Populate with ADA 703 (Signs) sections
- [ ] Add MUTCD Part 2 (Signs) relevant sections
- [ ] Add OSHA 1910.145 warning/caution/danger sign requirements
- [ ] Add IBC Chapter 10 egress signage requirements
