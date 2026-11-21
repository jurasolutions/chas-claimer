# Changelog

Every change to the claims desk that matters to the people who run it is written down here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- Signing in on the deployed desk works. The desk fetched the Access team's signing keys with an
  option the Workers runtime refuses, so it turned away every sign-in with "You're signed out". The
  test network now refuses that option too, the way the runtime does.

## 0.1.0 — 2026-11-14

The first version of the claims desk. It runs on synthetic data only until the clinic's
data-intermediary agreement is in place.

### Added

- **Importing visits.** A small connector runs at the clinic, reads its records through a source
  mapping (a SQLite file or a folder of CSV files) and sends claim-ready visits to the desk. It
  only reads the clinic's records and never changes them. Importing the same visit again changes
  nothing unless its details changed. A changed visit updates claims that haven't been sent yet,
  and flags sent ones as changed after submission for a person to look at. A synthetic clinic
  ships with the desk for demos and training.
- **Scheme rules and the payer waterfall.** Each visit is checked against the CHAS dental
  schedule, MediSave (Flexi-MediSave and the surgical TOSP list, including the limit per body
  system) and each insurer's policy limits. The desk then asks payers in order, by default CHAS,
  then MediSave, then insurance, each claiming from what the one above it left. The patient pays
  the rest. Rates, caps and benchmarks are settings with a source and an "as of" date, not fixed
  in the code. When a payer lower in the order has already been sent its claim, the desk takes
  that amount off the fee first. It holds every unsent claim on the visit if the sent claims
  already add up to more than the fee.
- **Claim lifecycle and audit.** A claim moves from needs attention to ready, approved,
  submitted, accepted or rejected, and paid, or is withdrawn or written off. Only a reviewer
  approves. Every change of state, every attempt to send and every time someone reveals a
  patient's identity is written to the claim's history.
- **Ways to send a claim.** Each payer has one channel. *Assisted* gives the officer a checklist
  in the portal's order with copy buttons, and records the reference the portal gives back.
  *File* produces one CSV in the payer's column layout. *API* posts each claim to the payer's
  HTTPS address with its own token and a repeat-safe key. The *payer simulator* stands in for a
  payer so the team can rehearse accepting, rejecting and paying claims. It works only in demo
  mode or on your own machine.
- **Remittances.** Import a payer's statement of what it paid, and the desk matches each line to
  its claim by reference, by patient or by hand, and records the payment. The same file imported
  twice adds nothing.
- **AI suggestions, behind a de-identification gate.** Four optional buttons: suggest a code
  mapping, explain a rejection, draft a justification and propose a source mapping. Nothing is
  saved until a person accepts it. Every prompt passes through a gate that removes the patient's
  identity and anything shaped like an NRIC, FIN, phone number, email or postal code. If anything
  is left, the request is refused and nothing is sent. A daily call cap applies across the desk.
- **Protecting identifiers.** Each visit's identity is sealed at import, patients are matched by
  a keyed hash, and screens show masked identifiers. Imports and statements carrying an NRIC
  outside the synthetic test block are refused until real identifiers are switched on.
- **Key rotation.** A reviewer can rotate the identifier key from Settings. The desk reads under
  the current and previous keys while it moves stored identities across, and shows what is left.
- **Settings.** The clinic, branches, dentists and their accreditation, payers with their
  channels and field templates, the code map, benchmarks and the waterfall order, edited on one
  screen and saved as one versioned document.
- **Sign-in.** The desk trusts only a verified Cloudflare Access token. Reviewers and officers
  are named by email in the deployment's settings.
- **Continuous integration.** Every push and pull request to `main` and the crew branches runs the
  typecheck, the tests and the build. It uses no secrets and deploys nothing.

### Known limits

These are the follow-ups an operator should know about. The full list is in
`.scratch/chas-claimer/follow-ups.md`.

- **A claim withdrawn by a settings change can't be brought back** (follow-ups 1 and 22).
  Reordering the waterfall or changing the code map can withdraw an unsent claim, and the desk
  has no way to revive it yet. The settings page warns before a reorder. Build the revive step
  before changing the waterfall or code map on the live desk.
- **A hand match can't be undone** (follow-up 7). The desk asks for confirmation first.
- **Statements over 50 lines are refused** (follow-up 8). Split a longer file before importing it.
- **A payment line can stay held after a crash** (follow-up 9), in the rare case that the worker
  stops between holding a line and recording its payment.
- **Every payer starts on the simulator channel** (follow-up 12). On the live desk, set each real
  payer's channel before claims are approved, or sending is refused.
- **The portal address has no field on the settings screen** (follow-up 10). The README says how
  to set it.
- **Free-text notes can carry a third party's name to the AI** (follow-up 20). Decide how to
  handle this before real identifiers are switched on.
- **The timed CHAS checklist hasn't been run by a person** (follow-up 21). Run it before the desk
  replaces the current way of claiming.
- **The API channel and one acceptance check need a staging payer** (follow-up 15).
- **Node 20 is past end of life** (follow-up 13). Move the Node version, CI and the wrangler pin
  to Node 22 together.
- **Some accessibility fixes belong in the Jura design system** (follow-ups 6, 14, 18 and 23):
  field hints, focus in dialogs and the default button type.
