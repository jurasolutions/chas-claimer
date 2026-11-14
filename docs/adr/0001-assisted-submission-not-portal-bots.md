# Assisted submission, not portal bots, for CHAS and MediSave

CHAS and MediSave claims are submitted in MOH's portals (MHCP, NPHC) by a named clinic user logged in with Singpass under the clinic's Corppass. There is no public API or batch upload; the only machine route is a clinic management system in Synapxe's SmartCMS programme. We decided the claims desk prepares and checks a claim packet and a person submits it in their own portal session, recording the portal reference back. We rejected a headless bot that logs in with stored credentials: it needs shared Singpass credentials (which government sources warn against), cannot pass Singpass 2FA unattended, and is blocked anyway because MHCP accepts only Singapore IP addresses from 13 Nov 2026. See `docs/research/sg-dental-claims.md` §5 and §6.

## Consequences

- Outcomes (accepted, rejected, paid) reach us when a person records them or a remittance is imported, not by polling a portal.
- A browser extension that fills the user's own logged-in tab, or a SmartCMS integration, can be added as another submission channel once MOH/AIC confirm it's acceptable. Neither needs the claim model to change.
