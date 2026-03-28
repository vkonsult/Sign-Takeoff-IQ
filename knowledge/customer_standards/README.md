# Customer Standards Knowledge Base

This directory contains customer-specific brand standards, sign standards, and requirements for recurring clients.

## Expected File Format

Files should be Markdown (`.md`) or plain text (`.txt`) with YAML front-matter metadata:

```markdown
---
jurisdiction: "ACME Corp"
doc_type: customer_standards
section: "Exterior Signage"
effective_date: "2024-03-01"
status: active
---

## ACME Corp Exterior Sign Standards

### Channel Letter Specifications
- Letter style: Helvetica Neue, Bold
- Letter height: 18" standard (24" for anchor locations)
- Return depth: 5"
- Illumination: White LED, 6000K color temperature
...
```

## Required Metadata Fields

| Field | Description | Example |
|-------|-------------|---------|
| `jurisdiction` | Customer or brand name | `"ACME Corp"`, `"Starbucks"` |
| `doc_type` | Always `customer_standards` for this directory | `customer_standards` |
| `section` | Sign category or standard section | `Exterior Signage`, `Interior Wayfinding` |
| `effective_date` | Date standards were issued/updated (ISO 8601) | `2024-03-01` |
| `status` | One of: `active`, `superseded`, `draft` | `active` |

## Security & Confidentiality

Customer standards may be proprietary. Ensure files in this directory:
- Do not contain trade secrets that should not be shared
- Are approved by the customer for internal use in estimating
- Are marked with the correct effective date to avoid using outdated specs

## Organization

Create one subdirectory per customer, or prefix filenames with the customer name:
- `acme_corp_exterior.md`
- `acme_corp_interior_wayfinding.md`
- `acme_corp_ada_requirements.md`

## TODO

- [ ] Establish customer standards intake process
- [ ] Create template for documenting customer sign standards
- [ ] Define update/expiration review cadence for customer documents
