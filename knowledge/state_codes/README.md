# State Codes Knowledge Base

This directory contains state-level sign regulations, codes, and standards by state.

## Expected File Format

Files should be Markdown (`.md`) or plain text (`.txt`) with YAML front-matter metadata:

```markdown
---
jurisdiction: "CA"
doc_type: state_codes
section: "CBC 11B-703"
effective_date: "2020-01-01"
status: active
---

Content of the state sign regulation...
```

## Required Metadata Fields

| Field | Description | Example |
|-------|-------------|---------|
| `jurisdiction` | Two-letter state code (uppercase) | `CA`, `TX`, `NY`, `FL` |
| `doc_type` | Always `state_codes` for this directory | `state_codes` |
| `section` | Code section reference | `CBC 11B-703`, `Texas Accessibility Standards 703` |
| `effective_date` | Date regulation took effect (ISO 8601) | `2020-01-01` |
| `status` | One of: `active`, `superseded`, `draft` | `active` |

## Directory Conventions

Organize files by state using subdirectory or filename prefix:
- `CA_CBC_11B-703.md` — California Building Code accessibility signage
- `TX_TAS_signage.md` — Texas Accessibility Standards signage section
- `NY_fire_exit_signs.md` — New York fire exit sign requirements

## TODO

- [ ] Add California CBC Chapter 11B accessibility signage sections
- [ ] Add California Title 19 fire signage regulations
- [ ] Add Texas Accessibility Standards (TAS) sign requirements
- [ ] Add Florida Accessibility Code sign provisions
- [ ] Add New York City signage codes
