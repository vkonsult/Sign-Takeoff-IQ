# City & Local Codes Knowledge Base

This directory contains city, county, and local jurisdiction sign regulations and permit requirements.

## Expected File Format

Files should be Markdown (`.md`) or plain text (`.txt`) with YAML front-matter metadata:

```markdown
---
jurisdiction: "Los Angeles, CA"
doc_type: city_codes
section: "LAMC 91.6202"
effective_date: "2023-06-01"
status: active
---

Content of the local sign regulation...
```

## Required Metadata Fields

| Field | Description | Example |
|-------|-------------|---------|
| `jurisdiction` | City and state name | `"Los Angeles, CA"`, `"Austin, TX"` |
| `doc_type` | Always `city_codes` for this directory | `city_codes` |
| `section` | Local code section reference | `LAMC 91.6202`, `Austin City Code 25-10` |
| `effective_date` | Date regulation took effect (ISO 8601) | `2023-06-01` |
| `status` | One of: `active`, `superseded`, `draft` | `active` |

## Content Guidelines

- Include permit application requirements and fees where known
- Note variance procedures and appeal processes
- Include contact information for the relevant AHJ (Authority Having Jurisdiction)
- Flag any preemption or conflict with state/federal requirements

## TODO

- [ ] Add Los Angeles sign ordinance sections
- [ ] Add Chicago sign ordinance relevant sections
- [ ] Add Houston development code sign regulations
- [ ] Add Phoenix zoning code signage standards
- [ ] Add common permit checklist items per jurisdiction
