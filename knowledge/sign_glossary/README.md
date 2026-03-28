# Sign Glossary Knowledge Base

This directory contains industry terminology, definitions, and technical glossary entries for sign fabrication and installation.

## Expected File Format

Files should be Markdown (`.md`) or plain text (`.txt`) with YAML front-matter metadata:

```markdown
---
jurisdiction: universal
doc_type: sign_glossary
section: "Materials"
effective_date: "2024-01-01"
status: active
---

## Aluminum Composite Material (ACM)

A flat panel consisting of two thin aluminum sheets bonded to a polyethylene core.
Used for: Cabinet sign faces, panel signs, building identification.
Typical thickness: 3mm or 4mm
Trade names: Alucobond, Dibond, Reynobond

...
```

## Required Metadata Fields

| Field | Description | Example |
|-------|-------------|---------|
| `jurisdiction` | Use `universal` for industry-wide terms | `universal` |
| `doc_type` | Always `sign_glossary` for this directory | `sign_glossary` |
| `section` | Category of terms | `Materials`, `Illumination`, `Mounting`, `Regulatory` |
| `effective_date` | Date this glossary entry was created/updated | `2024-01-01` |
| `status` | One of: `active`, `superseded`, `draft` | `active` |

## Suggested Term Categories

Organize glossary files by category:
- `materials.md` — ACM, HDU, PVC, vinyl, acrylic, polycarbonate, aluminum
- `illumination.md` — LED, neon, halo-lit, internally illuminated, EMC
- `mounting.md` — Direct mount, standoff, cabinet, raceway, through-wall
- `finishes.md` — Powder coat, anodize, vinyl wrap, paint, brushed, mirror
- `sign_types.md` — Monument, pylon, channel letter, cabinet, wayfinding, ADA
- `regulatory.md` — AHJ, variance, permit, UL listing, listed assembly

## TODO

- [ ] Populate materials glossary with common sign materials and specs
- [ ] Add illumination types and energy compliance terms
- [ ] Add mounting hardware and installation terminology
- [ ] Add finish specifications and color matching terminology
- [ ] Add trade abbreviations used in sign schedules
