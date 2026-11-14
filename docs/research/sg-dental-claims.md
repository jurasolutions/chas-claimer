# How Singapore dental clinics claim CHAS, MediSave and insurance today

*Research note for chas-claimer. Sources retrieved 2026-11-13. Every figure below is copied from
the official page cited next to it, with the date it was read. Treat any figure as configuration
with a source and an "as of" date, never as hard-coded truth (repo `CLAUDE.md`, numbers rule).*

**Confidence labels.** **High**: stated on an official MOH, CHAS/AIC, CPF or insurer page or
document that I read directly. **Medium**: an official page states it indirectly, or a
first-party vendor page says it. **Low / inference**: my reasoning from the sources, or a
secondary source. These are marked *Inference*.

---

## Summary

1. **CHAS dental claims go through the MOH Healthcare Claims Portal (MHCP)** at
   `mhcp.moh.gov.sg`, logged in with Singpass under the clinic's Corppass. They can also go
   from a clinic management system (CMS) that has joined Synapxe's SmartCMS programme. I found
   **no public API and no batch file upload** for CHAS. (High for MHCP and CMS; the absence of a
   public API is what I could find, not a confirmed fact.)
2. **From 13 Nov 2026 (today), MHCP accepts connections from Singapore IP addresses only.** Any
   server-side automation hosted outside Singapore, including default Cloudflare egress, would be
   blocked. (High)
3. **CHAS rules a claim engine must enforce:** submit within **30 days** of the visit; **one
   dental claim per patient per day**; multi-visit procedures (crowns, dentures, root canals)
   are claimed only once complete, and before the card expires; per-procedure annual and
   3-yearly frequency limits; GST is added before the subsidy is applied. (High)
4. **CHAS dental subsidy is a fixed maximum per procedure per claim, by card tier.** It ranges
   from $7.50 (Orange X-ray) to $625 (PG permanent crown). CHAS Green carries no dental subsidy.
   The full table is in §1.5. (High)
5. **New governance, 2025–2026:** MOH dental fee benchmarks for 18 procedures (from 1 Oct 2025).
   **Clinical justification is required for CHAS claims above the benchmark from 1 Sep 2026.**
   Flexi-MediSave accreditation is mandatory: CHAS dental clinics not accredited by
   **31 Dec 2026** are offboarded. (High)
6. **MediSave for dental covers two different things.** (a) Surgical procedures listed in MOH's
   Table of Surgical Procedures (TOSP), such as impacted-tooth removal, implant insertion and
   peri-radicular surgery, under day-surgery limits of $240 (Table 1A) to $5,290 (Table 7C) per
   operation. (b) **Flexi-MediSave**, up to $400 a year for patients aged 60 and over, for
   permanent crowns and root canal treatment at CHAS dental clinics, from mid-2026. (High)
7. **MediSave claims go through the National Platform for Healthcare Claims (NPHC).** NPHC
   replaced MediClaim from 12 Nov 2024. It is a web portal (Corppass, then Singpass, then an
   NPHC sub-administrator assigns roles). Clinics that use MHCP are excluded from NPHC access.
   The patient must sign a **Medical Claims Authorisation Form (MCAF)** first. (High for NPHC
   and MCAF. Which portal a CHAS dental clinic uses for Flexi-MediSave is an inference, see §2.)
8. **Insurance and TPA claims are private and vary by payer.** Each TPA or insurer (IHP,
   Alliance, MHC, Fullerton, Singlife, Income, AIA, Prudential, Great Eastern) runs its own
   panel contract, member-card check, Letter of Guarantee (LOG) or pre-authorisation, portal or
   paper form, and **its own benefit code set**. Singlife's Denticare form uses codes such as A01
   and N01, for example. Panel-clinic portals are not publicly documented. (High that the codes
   vary, from the Singlife form. Low on portal mechanics.)
9. **Compliance boundaries:** MOH Circular 02/2026 says to disclose to insurers only what is
   relevant, with documented patient consent (for example, the MCAF), and never raw EMR. NEHR
   must never be accessed for insurance purposes. The Healthcare Services Act and its
   regulations require protecting patient records from unauthorised access. Sharing Singpass or
   Corppass credentials is warned against by government sources. **For CHAS and MediSave, the
   safe adapter pattern is "portal-assist": a human in the clinic's own MHCP or NPHC session.
   Avoid headless bots using shared credentials.** (High for the circular. The credential and
   automation conclusion is *Inference*.)
10. **Industry pain points are real and documented.** A May 2026 College of Family Physicians
    Singapore (CFPS) review of the Plato CMS reports that "the clinic must still go through MHCP
    for CHAS and Medisave claims" and that reconciliation means going through claim reference
    numbers by hand. MOH has terminated or suspended dental clinics for undocumented or
    over-limit CHAS claims. Validation and an audit trail are the product's value, not only
    submission. (Medium)

---

## 1. CHAS (dental)

### 1.1 How submission works

- **Two channels:**
  - **MHCP web portal**, entered claim by claim per visit.
  - **A SmartCMS-integrated CMS** that submits to MOH directly, with no separate MHCP login.

  The CHAS dentist FAQ notes that "Both the Clinic Management System (CMS) and MOH Healthcare
  Claims Portal (MHCP) platforms have a function for you to check your patient's dental
  procedure balance". It refers clinics to the CMS and MHCP user guides.
  [CHAS FAQ for Dentists] — **High**.
- **SmartCMS** is Synapxe's (formerly IHiS) programme for CMS vendors. It provides "an integrated
  means to perform their claim / report submission under selected government schemes" such as
  CHAS and CDMP. Synapxe "invites all CMS Vendors" to participate.
  [Synapxe SmartCMS, via search snippet; the page returned 403 to direct fetch] — **Medium**.
- **No public API or file upload.** I found no MOH interface specification, sandbox or CSV/batch
  upload for CHAS. The integration seems to exist only for SmartCMS participants, under
  agreement with Synapxe. — **Inference (Low–Medium)**.
- **Fallback in practice.** A CMS vendor help page describes this: when a CHAS claim "is not
  Automatic or rejected or needs a manual action", staff "submit in the web portal then come
  back to CMS to update the claim". [Healthway Medical FAQ, via search snippet] — **Medium**.
  That is the double entry our product could reduce.

### 1.2 System and login

- **System:** MOH Healthcare Claims Portal, `https://mhcp.moh.gov.sg/web/`. The home page shows
  "Select Login → MHCP Portal → Singpass Login" (route `/web/Account/CorpPassLogin`). It links
  "Dental Clinic (CHAS only)" sign-up to the MediClaim accreditation app.
  [MHCP home, read 2026-11-13, "Last updated 26-10-2026"] — **High**.
- **Login:** Corppass-authorised Singpass. Each staff member logs in as themselves under the
  clinic's Corppass entity. — **High** (MHCP home, and the NPHC access procedure on FSAE).
- **Network restriction:** "with effect from 13 Nov 2026, access to the MOH Healthcare Claims
  Portal (MHCP) will be restricted to users accessing from Singapore IP addresses only."
  [MHCP home notice] — **High**.
- **Accreditation:** "To participate in CHAS, clinics need to onboard both CHAS and the
  Flexi-MediSave scheme". CHAS needs at least two staff to complete e-learning, one of them a
  practitioner with a valid practising certificate. [CHAS FAQ for Dentists; FSAE CHAS
  accreditation criteria] — **High**.

### 1.3 Required data per claim

MOH does not publish the MHCP claim form's field list. The list below separates what the
official rules make necessary from what is likely.

| Field | Basis | Confidence |
|---|---|---|
| Patient NRIC/FIN | Eligibility is tied to the cardholder, and MHCP checks balances per patient | High that identity is needed; exact identifier format not published |
| Card tier (PG / MG / Blue / Orange / Public Assistance) | The subsidy amount depends on tier | High |
| Visit date | 30-day deadline; one claim per patient per day | High |
| Procedure(s) from the CHAS dental list (§1.5), with quantity | Subsidy and limits are per procedure | High |
| Upper or lower arch for dentures; tooth type for root canal (anterior, pre-molar, molar), extraction (anterior, posterior) and filling (simple, complex) | Distinct subsidy lines | High |
| Fee charged (before subsidy, GST-inclusive where applicable) | The itemised bill must show total charges before subsidy; GST is applied before subsidy | High |
| Clinic GST status | MHCP notice to "select the GST/Non GST clinic option correctly before submitting claims" (search snippet) | Medium |
| Clinic identifier (HCI/licence code) and treating dentist's registration number | Accreditation is per clinic and practitioner | *Inference*: not published as fields |
| Clinical justification when fee > benchmark (from 1 Sep 2026) | MOH requirement | High that it is required; **how it is captured (free text, attachment) is not public** |
| Completion date for multi-visit procedures | Claimable only once complete and before card expiry | High |

**Patient consent:** I found no CHAS-specific patient consent form for dental claims. Patients
present their CHAS, PG or MG card. MCAF applies to MediSave, not CHAS. — **Medium** (absence of
evidence).

**Itemised bill (mandatory):** "All CHAS clinics are required to issue an itemised bill to all
CHAS (including PG and Public Assistance) patients". It must show the total before subsidy
(with a breakdown), the total CHAS subsidy and the amount the patient pays.
[CHAS FAQ for Dentists] — **High**.

### 1.4 Deadlines and timing

- "Clinics have 30 days from the patient's visit date to submit a claim." — **High**
  [CHAS FAQ for Dentists].
- Reimbursement: "within 1 month from the claim approval date if there are no issues." —
  **High** [same].
- No transaction fees are deducted from subsidy amounts. — **High** [same].

### 1.5 Subsidy schedule (CHAS dental, maximum subsidy per claim, S$)

Source: chas.sg per-card pages (CHAS Blue, CHAS Orange, Merdeka Generation, Pioneer Generation,
CHAS Green), read 2026-11-13. The pages show no "last updated" date. The MOH press release of
1 Sep 2025 dates the current restorative rates and the Orange preventive extension to
**1 Oct 2025**. — **High**.

| Procedure | PG | MG | Blue | Orange | Claim limit |
|---|---|---|---|---|---|
| Consultation | 30.50 | 25.50 | 20.50 | 13.50 | 2 per calendar year, 6 months apart; full oral exam and an updated chart; not for reviews during or after treatment |
| Polishing | 30.50 | 25.50 | 20.50 | 13.50 | 2 per calendar year |
| Scaling | 40.00 | 35.00 | 30.00 | 20.00 | 2 per calendar year |
| Topical fluoride | 30.50 | 25.50 | 20.50 | 13.50 | 2 per calendar year |
| X-ray | 21.00 | 16.00 | 11.00 | 7.50 | 6 per calendar year |
| Extraction, anterior | 38.50 | 33.50 | 28.50 | 19.00 | 4 per calendar year, shared across extraction types |
| Extraction, posterior | 78.50 | 73.50 | 68.50 | 45.50 | (shared, as above) |
| Filling, complex | 60.00 | 55.00 | 50.00 | 33.50 | 6 per calendar year, shared across filling types |
| Filling, simple | 40.00 | 35.00 | 30.00 | 20.00 | (shared, as above) |
| Re-cementation | 45.00 | 40.00 | 35.00 | 23.50 | 2 per calendar year |
| Denture reline/repair (upper or lower) | 85.00 | 80.00 | 75.00 | 50.00 | 1 upper + 1 lower per calendar year |
| Permanent crown | 625.00 | 620.00 | 615.00 | 410.00 | 4 per calendar year |
| Removable denture, complete (upper or lower) | 418.50 | 413.50 | 408.50 | 272.50 | 1 upper + 1 lower per 3 calendar years |
| Removable denture, partial, complex (6 or more teeth) | 395.50 | 390.50 | 385.50 | 257.00 | 1 upper + 1 lower per 3 calendar years, shared across partial types |
| Removable denture, partial, simple (fewer than 6 teeth) | 314.00 | 309.00 | 304.00 | 202.50 | (shared, as above) |
| Root canal treatment, anterior | 336.00 | 331.00 | 326.00 | 217.50 | 2 per calendar year, shared across root canal types |
| Root canal treatment, molar | 594.50 | 589.50 | 584.50 | 389.50 | (shared, as above) |
| Root canal treatment, pre-molar | 472.50 | 467.50 | 462.50 | 308.50 | (shared, as above) |

- **CHAS Green:** its card page lists no dental subsidy, only chronic, screening and vaccination
  benefits. — **High**.
- **Public Assistance:** "no fees should be collected for CHAS-covered procedures"; the government
  reimburses the full visit cost. [CHAS FAQ for Dentists] — **High**.
- **Per-visit cap:** none beyond the one-claim-per-patient-per-day rule and the per-procedure
  limits above. — **High** that no other cap is published.
- **Fee benchmarks (from 1 Oct 2025):** MOH published benchmarks for 18 CHAS dental procedures,
  e.g. consultation **$21–$31** and permanent crown **$750–$1,400**. They are "not meant to be
  strict fee caps". Clinics must display them beside their price list. [MOH press release,
  1 Sep 2025, Annex B] — **High** for these two ranges. I did not transcribe the other 16; read
  Annex B before encoding them.
- **Stale figures to ignore:** clinic and blog pages still quote "up to $256.50 per procedure"
  (Blue) and similar. These predate the Oct 2025 changes. Do not use them.

### 1.6 Rules and enforcement

- Dentists must make a clinical assessment that the patient meets the CHAS claim guidelines for
  each procedure. [chas.sg dental subsidies page] — **High**.
- MOH audits CHAS claims. It terminated Jesselton Dental Centre (Jan 2021) after audits found
  "numerous improper claims for CHAS subsidies with no proper supporting documentation" and
  claims over the limit. It terminated Loh & Loh Dental Surgery (Jul 2024) for "claims for
  treatments not administered at the branch they were claimed at" and "tampering of patients'
  addresses in the invoices". [MOH newsroom] — **High**. Every claim needs a traceable link to
  clinical documentation and the correct branch.
- **Rejection reason codes:** not public. The FAQ gives "a patient's annual subsidy being fully
  used" as an example and routes queries to the clinic's AIC Account Manager
  (`https://for.sg/amfinder`). — **High** that codes are not public.

---

## 2. MediSave (dental)

### 2.1 What is claimable

- **Surgical dental procedures in the TOSP.** CPF says: "You can use your MediSave for selected
  complex dental procedures that involve surgery … and are performed for medical reasons,
  subject to the MediSave withdrawal limits applicable for day surgeries."
  [CPF, "Can I use my MediSave to pay for dental treatments?", updated 31 May 2026] — **High**.
- **TOSP rule:** "Any procedures not listed or without a table ranking 1A to 7C are not
  claimable." Procedures marked "MSP" (Minor Surgical Procedure) are non-claimable. For one
  surgical episode, use a single TOSP code if one adequately describes it.
  [MOH TOSP, as of 1 Jan 2024] — **High**. MOH FCM No. 1/2026 announces TOSP updates, so check
  for a newer TOSP edition before encoding.
- **Dental-relevant TOSP codes** (MOH TOSP as of 1 Jan 2024, extracted from the PDF; a subset):

  | Code | Description (abridged) | Table |
  |---|---|---|
  | SF812T | Tooth (superficial), unerupted/partially erupted/impacted, excision with removal of bone (no tooth division) | 1B |
  | SF813T | Tooth (superficial), impacted, excision with removal of bone and tooth division | 2C |
  | SF810T | Tooth (deep, completely buried in bone), excision with bone removal and tooth division | 3A |
  | SF801T / SF800T | Teeth (2–3), impacted, excision with bone removal, without / with tooth division | 3B / 3C |
  | SF803T / SF802T | Teeth (4 or more), impacted, without / with tooth division | 4A / 4B |
  | SF811T | Tooth (superficial), impacted, excision with incision of soft tissue only | **MSP (not claimable)** |
  | SF816T | Tooth, simple impacted/fractured, removal of multiple roots | 2C |
  | SF817T | Tooth, impacted, excision with release of neurovascular bundle | 4A |
  | SF701T–SF705T | Unerupted/impacted tooth or teeth, surgical exposure (with or without bonding for traction) | 1C–4A |
  | SF708T / SF818T | Peri-radicular surgery, single-rooted / multi-rooted or more than 1 tooth | 2C / 3A |
  | SF814T | Tooth, dislocation, reimplantation and transplantation | 3A |
  | SB816M | Mandible or maxilla, insertion of endosseous dental implant (single); "number of claims = number of implants placed" | 2C |
  | SB702M | Dental implant(s), osseointegrated, trephine removal | 1C |
  | SB802M / SB803M | Alveolar defect: complex alveoloplasty, sinus lift, ridge augmentation with graft / simple alveoloplasty | 3A / 2C |
  | SB807M–SB810M | Odontogenic cyst enucleation (by size) / marsupialisation | 2B–4A |
  | SF703M / SF706M | Periodontium, open flap debridement (1 / 2 quadrants) | 1B / 2A |
  | SF709M / SF710M | Periodontium, bone augmentation/regeneration (autogenous / non-autogenous) | 2C / 2A |
  | SF701M | Mouth, frenal attachment, release | 1B |

  TOSP guidance also notes that for uncooperative or special-needs paediatric patients needing
  general anaesthesia, the dentist should refer to a specialist or paediatric dentist. —
  **High**.
- **Withdrawal limits (day surgery):** "up to $830 per day for ward charges and a fixed limit
  for operation ranging from $240 (Table 1A) to $5,290 (Table 7C)". The limit includes surgeon,
  anaesthetist and facility fees. At most 3 surgical procedures, across no more than 2
  anatomical systems with no more than 2 procedures each.
  [CPF MediSave Withdrawal Limits PDF, "Last updated on 1 April 2025"] — **High**.

  | Table | A | B | C |
  |---|---|---|---|
  | 1 | $240 | $420 | $490 |
  | 2 | $760 | $1,120 | $1,120 |
  | 3 | $1,390 | $1,740 | $1,920 |
  | 4 | $2,380 | $2,440 | $2,540 |
  | 5 | $2,610 | $2,660 | $2,770 |
  | 6 | $3,260 | $3,610 | $3,960 |
  | 7 | $4,340 | $4,830 | $5,290 |

  Third-party dental sites quote different per-procedure figures, e.g. "$350 / $950 / $1,250"
  for wisdom teeth. **Ignore them** and derive the limit from the TOSP table ranking.
- **Flexi-MediSave (dental):** for members aged 60 and over, "up to $400 a year, per patient",
  from their own or a spouse's MediSave (spouse also 60 or over). [CPF "What is outpatient
  Flexi-MediSave", updated 27 Oct 2026] The limit rose from $300 to $400 on 1 Oct 2025 [CPF
  Budget 2025]. Flexi-MediSave was extended to "permanent crowns and root canal treatments" in
  "mid-2026" [CPF Budget 2025; MOH 1 Sep 2025]. The dentist must be a MediSave-accredited
  practitioner to submit these claims [CHAS FAQ for Dentists]. — **High**. Note that the CPF
  Flexi-MediSave page (27 Oct 2026) still lists only polyclinics, specialist outpatient clinics
  and CHAS GP clinics as settings, so the dental rollout detail is not yet on that page.

### 2.2 How submission works, system and login

- **NPHC** "is a government system to administer MediSave, MediShield Life, and Integrated
  Shield Plans claims". It supports "claim submissions by healthcare providers" and enquiries on
  MediSave balances. [nphc.moh.gov.sg/about] — **High**.
- NPHC "combines the functionalities of CPFB's claim processing systems, MediClaim, and the
  current online portal". Access: the organisation's Corppass Admin adds the employee's Singpass
  and grants the NPHC digital service, then an **NPHC sub-administrator** creates the user and
  assigns roles. Supporting documents can be attached in the portal. Use is governed by the
  MediSave/MediShield Life "Terms and Conditions of Approval", and MOH/CPF "may suspend or revoke"
  access. **Eligibility excludes clinics that use, or intend to use, MHCP.**
  [FSAE NPHC Claims Application, updated 5 Nov 2026] — **High**.
- MediClaim's portal notice states NPHC Online replaced it from **12 Nov 2024** (search snippet
  of `mediclaim.moh.gov.sg`; the host did not resolve when fetched). — **Medium**.
- Institutions may submit MediSave/MediShield Life claims via NPHC "only after" e-learning and
  accepting CPF Board's T&Cs. "Accreditation by MOH is mandatory for submitting claims on behalf
  of patients." [FSAE overview] — **High**.
- *Inference:* a CHAS dental clinic is an MHCP user, so it probably submits **Flexi-MediSave**
  through MHCP (as CHAS GP clinics do for CDMP and Flexi-MediSave). It would submit **surgical
  TOSP MediSave** either through MHCP or NPHC, depending on its accreditation set-up. **Confirm
  with the clinic.**
- **API / file upload:** none public for NPHC. — **Low** (absence of evidence).

### 2.3 Required documents and fields

- **MCAF** is mandatory before claiming: patients "authorise them to submit the claim on your
  behalf". MCAF(S) covers a single institution (one visit, a period, or standing until revoked).
  MCAF(M) covers public healthcare institutions only, so a private dental clinic uses MCAF(S).
  [CPF MCAF article, updated 5 Jan 2026] — **High**.
- *Inference* (fields not published): patient NRIC/FIN; MediSave account owner if a family
  member pays (and their MCAF); TOSP code(s) and table; date of surgery; day-surgery flag;
  surgeon's and anaesthetist's fees and facility fee; dentist's MediSave accreditation
  identifier; clinic accreditation; diagnosis; amount claimed, capped at the table limit; MCAF
  reference.

### 2.4 Deadlines

- No MediSave claim submission deadline was found on an official page. — **Low**. Ask the clinic
  or CPF.

---

## 3. Insurance (corporate dental, TPAs)

### 3.1 How submission works

Two models recur in insurer documents:

- **Panel or direct billing.** The member presents a membership card (and NRIC/FIN) at a panel
  clinic. The clinic bills the insurer or TPA, and the patient pays only non-covered items.
  - Singlife's Denticare form: "For patient present with Membership Card, no payment needs to be
    made by the patient at the clinic for all benefit listed in this form." "Reimbursement made
    by Singapore Life Ltd. to the clinic will be in accordance to the 'Schedule of Dental
    Benefit'". [Singlife Dental Claim Form (Superior Plan), modified 2025-12-05] — **High**.
  - MHC's FAQ: members present the "MHC card together with their NRIC/FIN at the panel clinics
    upon registration". [MHC Asia, via search snippet] — **Medium**.
- **Member reimbursement (non-panel).** The patient pays and then claims through the insurer's
  app, portal or e-form, e.g. Income MHS (eSign form or email), AIA eBen, Singlife app, IHP
  `eclaim.ihp.com.sg`. — **Medium–High** for the existence of these channels. Under this model
  the clinic only supplies an itemised invoice and, sometimes, a completed dentist section.

### 3.2 Systems and login (by payer)

| Payer / TPA | Clinic-side channel | Confidence |
|---|---|---|
| IHP | Portal and the "IHP OneConnect" app (member side). IHP is moving all portal users to new login credentials from 1 Jul 2026, per a PDPC/CSA advisory (QBE notice). Clinic-side portal not publicly documented | Medium (member side), Low (clinic side) |
| Alliance Healthcare | Panel network ("Alliance MediNet"); clinic submits directly per clinic sites; the portal is not public | Low |
| MHC Asia | Panel network, card + NRIC at registration, LOG via the m-Plify app; clinic portal not public | Low–Medium |
| Fullerton Health | TPA for some insurers' panels (network team fhn3@fullertonhealth.com); provider portal not public | Low |
| Singlife (Denticare) | Paper or e-form with a dentist section and benefit codes; "Denticare Claim Procedure" referenced but not public | High (form) |
| Income MHS | Member-submitted (eSign/PDF/email) | High |
| Prudential (PRUPanel Connect), AIA, Great Eastern | Panel programmes exist; dental clinic submission not documented publicly | Low |

*Inference:* every panel relationship has a **contracted, non-public** submission method,
usually a TPA web portal, sometimes email or paper with a monthly statement. The clinic is the
only source of truth for this. Expect **no APIs** available to a non-member third party.

### 3.3 Required fields (evidence: Singlife Denticare form)

- **Member section:** insured employee's name, NRIC/passport, marital status, date of birth,
  gender, email, contact number, occupation; the patient's equivalent fields if a dependant,
  plus relationship; bank details (for reimbursement); medical information authorisation
  (signed; a parent or guardian signs if the patient is under 21); PDPA consent.
- **Employer section:** date of employment, effective date of insurance, eligible plan (A–K).
- **Dentist section:** benefit **code**, **tooth number**, amount per line; date of service;
  GST amount (if GST-registered); total charged; dentist's signature and clinic stamp; patient
  declaration.
- **Insurer-specific benefit codes (Singlife):** A01 consultation and oral exam; B01–B04
  X-rays; C01 scaling and polishing; D01–D04 amalgam; E01–E03 tooth-coloured restorations;
  F01–F02 extractions; G01–G05 oral surgery; H01–H02 periodontal; I01–I05 pulp/root canal;
  J01–J03 miscellaneous; K01 alveoplasty; L01–L07 dentures; M01 crowns; N01 complicated wisdom
  tooth surgery. — **High** (from the form). **Each insurer has its own codes. The clinic's
  internal procedure code must be mapped per payer.**
- **Pre-authorisation:** some dental panels need a Letter of Guarantee, "Verification of
  Benefits" or "Authorisation Letter" before treatment (clinic marketing page). — **Low–Medium**.

### 3.4 Deadlines and rules

- No dental TPA submission deadline was found publicly. — **Low**.
- **Disclosure limits (MOH Circular 02/2026, 9 Jan 2026, to all HCSA licensees and
  dental practitioners):**
  - Get documented patient consent (e.g., MCAF and policy forms).
  - "Information irrelevant to the patient's claim … must not be disclosed to the insurer,
    regardless of the scope of patient consent".
  - Prepare separate reports or summaries rather than raw EMR. Insurers "should not be given
    access to the raw medical records"; redacted extracts only in exceptional cases.
  - "access to NEHR is not allowed for insurance purposes under any circumstances".

  — **High**. Insurance adapters must send minimal, purpose-limited payloads, never a
  record dump.

---

## 4. Industry and vendors

- **SmartCMS (Synapxe)** is the government's integration route for CMS vendors: CHAS, CDMP,
  Healthier SG and NEHR. — **Medium** (programme page blocked; described through snippets and
  vendor pages).
- **Plato** (platomedical.com) markets "Make Dental CHAS Claims Directly in your Plato" (Feb
  2020): check the CHAS balance and claim without logging into the CHAS portal, as a "Tier One
  SmartCMS Partner". A **CFPS "CMS Sutra" review (25 May 2026)** reports "the clinic must still
  go through MHCP for CHAS and Medisave claims", "too much manual work involved with claims",
  and reconciling "claim reference numbers manually". — **Medium** (vendor marketing against a
  professional body's review).
- **UNO Technologies (UNO CMS)** says it is a "Preferred vendor of SmartCMS programme, currently
  tier 1". It claims to "Submit CHAS, PHPC, NIR, Medisave, and various MOH claims directly",
  with pre-submission balance, eligibility and tier checks and claim status updates. Its page
  lists Dental CHAS. — **Medium** (vendor self-description).
- **GPConnect** (Synapxe) is a GP CMS, reviewed by CFPS for MHCP and NEHR integration. It is
  not dental. — **Medium**.
- **Not verified:** Clinic Assist, Ezyclinic, Dentrix-style or other dental-specific local CMS.
  I found no first-party page confirming their CHAS or MediSave integration. CareStack's
  Singapore page says nothing about CHAS. Dentally's "MoH claim" article is New Zealand only.
  — **Low**.
- **Pain points (evidence above):**
  - Manual double entry when CMS submission fails or a scheme isn't integrated.
  - Manual reconciliation by claim reference.
  - Rejections from exhausted annual limits.
  - The 30-day deadline.
  - New benchmark-justification work from Sep 2026.
  - Audit exposure from documentation gaps (MOH termination notices).

---

## 5. Legal and compliance constraints for automation

| Topic | What the sources say | Confidence | Implication |
|---|---|---|---|
| Credentials | Corppass authorises **named individuals** (Singpass) per digital service, and an entity can authorise a **third-party entity** only for "digital services that allow Third Party Authorisation" (Corppass FAQ via snippet). SPF warns against sharing Singpass credentials and is charging people who did. Sharing a Corppass login is described as a breach of terms (secondary source) | Medium | Never store or share clinic staff Singpass credentials. Whether MHCP or NPHC allow Third Party Authorisation is **unknown**: ask MOH/AIC before Jura acts as a third-party entity |
| Headless RPA of MHCP/NPHC | No explicit public rule found either way. Singpass login uses the Singpass app or 2FA, so unattended login is impractical and would mean credential sharing. MHCP is now SG-IP only | *Inference* | Treat full browser automation as **not permitted unless MOH/AIC confirm in writing**. Use human-in-the-loop assist in the user's own session |
| Approved channel for system submission | SmartCMS participation (Synapxe), open to "all CMS Vendors" | Medium | The legitimate machine-to-machine path is to be (or integrate with) a SmartCMS-participating CMS |
| Healthcare Services Act | Licensees must keep every patient health record confidential and protect it from unauthorised access, disclosure, copying or use, **including extracts** (HCS (General) Regulations 2021, reg 38(1)–(2), cited in MOH Cir 02/2026) | High | Our DB extracts are covered: encryption, access control, audit log, minimal fields |
| Insurers | MOH Cir 02/2026: consent, relevance and minimum necessary; no raw EMR; no NEHR for insurance | High | Insurance payloads are summaries built from claim lines, not records |
| Health Information Act | Bill passed 12 Jan 2026; expected in force early 2027. Mandatory NEHR contribution by licensed providers, with security requirements; accessing NEHR for insurance is an offence (per MOH circular) | Medium (law-firm and Synapxe summaries) | Do not touch NEHR. Watch for security requirements on systems connected to it |
| PDPA | PDPC Healthcare Sector Advisory Guidelines (rev. 20 Sep 2023); Guide to Managing Data Intermediaries (2020). MOH MHC Cir 0001/2026 stops using NRIC numbers for authentication | Medium (not read in full) | Jura is a **data intermediary** of the clinic: written processing contract, protection and retention obligations, no NRIC as an authenticator. Repo rule: no identifiers to Anthropic |
| Scheme terms | MediSave/MSHL use is governed by CPF T&Cs of approval; MOH/CPF can suspend or revoke access; accreditation is "mandatory for submitting claims on behalf of patients" | High (existence); T&C text not retrieved | Submission must remain the accredited clinic's act. Our tool prepares; the clinic submits |

---

## 6. Implications for our adapter design

1. **The CHAS adapter is "portal-assist", not API.** Produce a validated claim packet per visit:
   tier, procedure lines mapped to the 18 CHAS items, fees, GST flag, completion status and a
   justification draft when the fee is above benchmark. A clinic user then submits it in their
   own MHCP session. Present it as a copy-ready checklist, ordered the way MHCP asks. A later
   option is a browser extension that fills fields in the user's own logged-in tab, only after
   MOH/AIC confirm this is acceptable. Record the MHCP claim reference back against the packet.
2. **The SmartCMS route is the only machine path.** If the clinic's CMS is already a SmartCMS
   participant, write claim-ready data back into that CMS rather than going to MHCP. Becoming a
   SmartCMS participant ourselves is a business decision (Synapxe agreement). Out of scope until
   the clinic answers §7.
3. **Hosting:** server-side calls to MHCP from Cloudflare are blocked by the SG-IP rule (13 Nov
   2026). Portal-assist sidesteps this because the user's browser is in Singapore. Any future
   server automation needs Singapore-pinned egress.
4. **MediSave adapter:** the same portal-assist pattern (NPHC or MHCP, see §2.2 inference).
   Validate before submitting:
   - TOSP code exists, is not MSP, and is current (the TOSP is versioned; FCM 1/2026).
   - At most 3 procedures across at most 2 systems.
   - Amount at or below the table limit.
   - MCAF(S) on file.
   - Dentist is MediSave-accredited.
   - For Flexi-MediSave: patient (or paying spouse) is 60 or over; procedure is a crown or root
     canal; $400 per year per patient. We cannot see the remaining balance, so show it as
     "check in portal".
5. **Insurance adapters: one per payer, with a mapping table.** Map clinic procedure codes to
   payer benefit codes, keep per-payer required fields (member ID, policy/plan, employer, tooth
   number), track LOG/pre-auth state, and output either a portal-assist checklist or a
   pre-filled PDF form. The minimal-disclosure rule from MOH Cir 02/2026 is built into the
   payload builder.
6. **Rules engine as versioned configuration.** Per-tier amounts, frequency limits, the 30-day
   window, one claim per patient per day, the multi-visit completion rule, card-expiry checks,
   benchmark thresholds (from 1 Sep 2026) and TOSP tables are all data with source URL and
   effective date. Encode them as data, not code.
7. **Local limit tracking is advisory.** MHCP or the CMS holds the authoritative balance across
   all clinics. Our counts only cover this clinic. Show "may exceed" warnings; never auto-reject.
8. **Status model:** draft → validated → ready → submitted (by whom, when, portal reference) →
   approved / rejected (reason as free text, since codes are not public) → paid (date, amount)
   → reconciled. Rejections need a resubmit-or-write-off path.
9. **Reconciliation:**
   - CHAS: reimbursement arrives within about one month of approval. I found no published
     format for remittance statements.
   - MediSave and TPAs: also unknown.
   - Design an importer for whatever the clinic receives (PDF or CSV statement, portal export,
     bank credit) and match on portal claim reference, then NRIC hash, date and amount.
     **Inference:** payment is by bank transfer or GIRO, which is not confirmed.
10. **Audit trail:** MOH terminations cite missing documentation and wrong-branch claims. Every
    packet should link to the clinical note ID, treating dentist, branch and itemised bill.

---

## 7. Open questions for the clinic

1. Which CMS or practice system holds the data? Is it a SmartCMS participant? Does it already
   submit CHAS, or do staff key claims into MHCP by hand?
2. Who logs into MHCP and NPHC today, and how many staff are Corppass-authorised? Would MOH/AIC
   allow Jura as a Corppass third-party entity? (Ask their AIC Account Manager.)
3. Monthly volume of CHAS, MediSave and insurance claims, and the split by card tier.
4. Is the clinic Flexi-MediSave (Dental) accredited, and are its dentists MediSave-accredited?
   Which portal do they use for Flexi-MediSave and for surgical (TOSP) claims?
5. How do they capture MCAF(S) today (paper or e-form), and where is it stored?
6. Which insurers and TPAs is the clinic on panel with? For each: submission method (portal,
   email, paper), pre-auth/LOG process, benefit code schedule, deadline, statement format.
7. What do approval, rejection and payment notices look like? Can they share redacted samples
   or blank templates (no patient data, since this repo is public)?
8. Recent rejection reasons and missed-deadline cases. How do they reconcile payments today?
9. How are fees above the MOH benchmark justified since 1 Sep 2026, and where?
10. Database type and access: read-only replica, export or API? Which tables hold procedures,
    tooth numbers, CHAS tier and card expiry?
11. Multi-branch? Claims must be made at the branch where treatment was given.

---

## Source list (retrieved 2026-11-13 unless noted)

**Official: MOH, CHAS/AIC, CPF, Synapxe**
- CHAS FAQ for Dentists: https://www.chas.sg/For-Clinics/FAQ-Dentist
- CHAS dental subsidies (limits): https://www.chas.sg/chas-dental-subsidies
- CHAS card pages (subsidy amounts):
  https://www.chas.sg/Using-CHAS/Cards-and-Subsidies/CHAS-Blue ·
  …/CHAS-Orange · …/CHAS-Green · …/Merdeka-Generation · …/Pioneer-Generation
- MOH, "Enhanced financing support for CHAS dental procedures and financial governance of CHAS
  clinics" (1 Sep 2025):
  https://www.moh.gov.sg/newsroom/enhanced-financing-support-for-chas-dental-procedures-and-financial-governance-of-chas-clinics/
- MHCP home (login, SG-IP notice): https://mhcp.moh.gov.sg/web/MHCPHome/Index
- NPHC about: https://nphc.moh.gov.sg/about
- FSAE NPHC claims application (updated 5 Nov 2026): https://fsae.moh.gov.sg/mmae/Others/NPHCClaimsApplication
- FSAE overview: https://fsae.moh.gov.sg/ · CHAS criteria: https://fsae.moh.gov.sg/mmae/ImportantInfo/CHASAccreditation
- MediClaim notice (NPHC replacement, snippet only): https://www.mediclaim.moh.gov.sg/webmediclaimcp
- MOH Table of Surgical Procedures (as of 1 Jan 2024):
  https://www.moh.gov.sg/docs/librariesprovider5/medisave/table-of-surgical-procedures-(as-of-1-jan-2024).pdf
- MOH FCM No. 1/2026, TOSP updates (not read):
  https://isomer-user-content.by.gov.sg/95/8d0d90d1-f8e1-41a0-b2f7-184efa36b97b/MOH%20FCM%20No.%201_2026%20UPDATES%20TO%20TABLE%20OF%20SURGICAL%20PROCEDURES%20AND%20CALL%20FOR%20SUBMISSION.pdf
- CPF MediSave Withdrawal Limits (1 Apr 2025):
  https://cpf.gov.sg/content/dam/web/member/healthcare/documents/MediSave%20Withdrawal%20Limits_1%20April%202025.pdf
- CPF, MediSave for dental (updated 31 May 2026): https://www.cpf.gov.sg/service/article/can-i-use-my-medisave-to-pay-for-dental-treatments
- CPF, Outpatient Flexi-MediSave (updated 27 Oct 2026): https://www.cpf.gov.sg/service/article/what-is-outpatient-flexi-medisave
- CPF Budget 2025: https://cpf.gov.sg/cpfbudget2025
- CPF, MCAF (updated 5 Jan 2026): https://www.cpf.gov.sg/service/article/what-is-the-medical-claims-authorisation-form-mcaf
- MOH Circular 02/2026, disclosure of patient medical records to insurers (9 Jan 2026):
  https://isomer-user-content.by.gov.sg/7/8d8bef0f-3ff0-4452-8311-1551f3553c56/MOH%20Cir%2002_2026%20Guidance%20on%20Disclosure%20of%20Patient%20Medical%20Records%20to%20Insurers.pdf
- MOH termination notices: Jesselton Dental Centre (13 Jan 2021)
  https://www.moh.gov.sg/newsroom/termination-of-jesselton-dental-centre-from-chas/ ·
  Loh & Loh (18 Jul 2024)
  https://www.moh.gov.sg/newsroom/revocation-of-medisave-and-medishield-life-accreditation-and-termination-of-chas-participation-for-life-family-clinic--loh---loh-clinic---surgery-and-loh---loh-dental-surgery/
- Synapxe SmartCMS (403 to direct fetch; snippets only): https://synapxe.sg/partner-us/smartcms
- MOH MHC Cir 0001/2026, NRIC guidelines (not read):
  https://isomer-user-content.by.gov.sg/7/071fae7b-eebc-450e-9783-2e311a5d759a/MOH%20MHC%20Cir%200001_2026%20Guidelines%20on%20Ceasing%20the%20use%20of%20NRIC%20Numbers%20for%20Authentication%20by%20Health.pdf
- PDPC Advisory Guidelines for the Healthcare Sector (not read in full):
  https://www.pdpc.gov.sg/organisations/regulations-decisions/regulatory-guidance/advisory-guidelines-for-the-healthcare-sector
- PDPC Guide to Managing Data Intermediaries (2020, not read in full):
  https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-to-Managing-Data-Intermediaries--2020.pdf

**Insurers and TPAs**
- Singlife Dental Claim Form (Superior Plan): https://content.singlife.com/content/dam/business/sg/documents/dental-claim-form-superior-plan.pdf
- Income MHS outpatient claim: https://www.income.com.sg/claims/outpatient-claim-(managed-healthcare-system)
- QBE notice on IHP login change: https://www.qbe.com/sg/intermediary/announcements/upcoming-change-to-ihp-portal-and-mobile-app-login-requirements
- MHC Asia contact: https://www.mhcasia.com/managedcare/contact-us/
- AIA eBen claims: https://eben.aia.com.sg/en/my-aia/member/claims.html

**Vendors and professional bodies (lower trust)**
- Plato, dental CHAS claims (19 Feb 2020): https://platomedical.com/make-dental-chas-claims-directly-in-your-plato/
- CFPS CMS Sutra Cycle 2, Plato (25 May 2026): https://www.cfps.org.sg/cms-sutra-cycle-2-plato/
- UNO Technologies, SmartCMS: https://puma-recorder-ftpr.squarespace.com/ihis-smartcms ·
  CHAS claims: https://puma-recorder-ftpr.squarespace.com/how-to-submit-chas-claims
- Healthway Medical CMS FAQ (snippet only): https://test-faq.healthwaymedical.com/?p=1239

**Secondary (context only)**
- Health Information Bill: https://www.gov.sg/explainers/parliament-jan2026/ ·
  https://www.bakermckenzie.com/en/insight/publications/2026/01/singapore-health-information-bill-passed-in-parliament
- Corppass third-party authorisation (secondary): https://rafflescorporateservices.com/?p=7833

## What could not be verified publicly

- The MHCP and NPHC claim form field lists, and any MOH interface spec, sandbox or batch upload.
- The MOH CHAS or MediSave rejection reason code list.
- Remittance and statement formats for CHAS, MediSave and TPAs, and the payment method.
- Whether MHCP or NPHC permit Corppass Third Party Authorisation, or any rule on RPA.
- Clinic-side TPA portals (IHP, Alliance, MHC, Fullerton, AIA, Prudential, Great Eastern) and
  their deadlines.
- A MediSave claim submission deadline.
- Which channel a CHAS dental clinic uses for Flexi-MediSave (inferred MHCP).
- The SmartCMS vendor list and which dental CMSs are integrated.
