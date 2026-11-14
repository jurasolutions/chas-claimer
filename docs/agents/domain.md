# Domain docs

This is a single-context repo.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root: the domain glossary (claims, schemes, payer channels).
- **`docs/adr/`**: the ADRs that touch the area you're about to work in.
- **`docs/research/sg-dental-claims.md`**: how CHAS, MediSave and insurance claims are made in Singapore today, with sources.

## Use the glossary's vocabulary

When your output names a domain concept (a ticket title, a test name, a type), use the term as
defined in `GLOSSARY.md`. If the concept isn't there yet, either you're inventing language
(reconsider) or there's a real gap (add it through `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an ADR, say so explicitly rather than silently overriding it.
