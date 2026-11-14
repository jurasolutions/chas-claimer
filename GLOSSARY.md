# Claims desk

A dental clinic's claims, from the visit in its own records to the payment from each payer. The
clinic is paid by government schemes (CHAS, MediSave) and by insurers; this context prepares,
checks, submits and reconciles those claims.

## The clinic's records

**Clinic database**:
The clinic's own system of record (its clinic management system). Read, never written.
_Avoid_: EMR, source system, CMS database

**Source mapping**:
The per-clinic description of how to read source visits out of the clinic database: one query (or CSV layout) per record type.
_Avoid_: schema map, ETL config

**Source visit**:
One patient visit as read from the clinic database: patient, branch, dentist, date, treatments and the patient's scheme cards and policies on that date. Immutable once imported; a changed visit arrives as a new revision.
_Avoid_: encounter, appointment, record

**Treatment**:
One line of work done at a source visit, in the clinic's own code and words, with its fee, GST, tooth and completion state.
_Avoid_: procedure (reserved for a scheme's list), service, item

**Completion date**:
The date a multi-visit procedure (crown, denture, root canal) was finished; the date its claim takes.
_Avoid_: fit date, end date

**Held line**:
An unfinished multi-visit treatment kept off a claim until its completion date.
_Avoid_: pending, parked

**Import**:
One run that brings source visits into the claims desk, from the connector or from the synthetic clinic.
_Avoid_: sync, extraction run

**Connector**:
The small program at the clinic that reads the clinic database through the source mapping and sends source visits to the claims desk.
_Avoid_: agent, bridge, extractor

**Branch**:
One clinic premises with its own licence and scheme registrations. A claim belongs to the branch where the treatment was done.
_Avoid_: location, site, outlet

## Payers and schemes

**Payer**:
Whoever is asked to pay part of a visit: CHAS, Flexi-MediSave, surgical (TOSP) MediSave, or an insurer (directly or through its TPA). MediSave counts as two payers because each has its own portal and rules.
_Avoid_: funder, provider (a provider is the clinic)

**Scheme**:
The kind of payer: CHAS, MediSave or insurance. Each scheme has its own rules and claim shape.
_Avoid_: programme, product

**Card validity**:
The dates between which a patient's CHAS tier applies. A card is valid on its expiry date.
_Avoid_: card status

**CHAS tier**:
The patient's subsidy level: Pioneer Generation, Merdeka Generation, CHAS Blue, CHAS Orange, CHAS Green or Public Assistance. Green carries no dental subsidy.
_Avoid_: card colour, card type

**CHAS procedure**:
One of the dental items on MOH's CHAS subsidy list (for example "Root canal treatment, molar"), each with a maximum subsidy per tier and a frequency limit.
_Avoid_: CHAS code, subsidy item

**TOSP code**:
A code from MOH's Table of Surgical Procedures, with a table ranking (1A to 7C, or MSP) that sets its MediSave **withdrawal limit** (the most MediSave may pay for the operation). MSP-ranked codes are not claimable. Its first two letters name the anatomical (body) system; the rule set caps how many procedures one claim may carry, in how many systems, and how many in each system.
_Avoid_: surgical code, procedure code

**Flexi-MediSave**:
MediSave used for outpatient dental crowns and root canals by patients aged 60 and over, up to a yearly amount per patient.
_Avoid_: outpatient MediSave

**MediSave account holder**:
Whose MediSave pays a claim: the patient, or a family member such as a spouse.
_Avoid_: payer (the payer is MediSave), owner

**MCAF**:
The account holder's signed Medical Claims Authorisation Form (single visit, period, or standing until revoked), which lets the clinic claim from their MediSave. A MediSave claim with no MCAF valid on its date cannot go.
_Avoid_: consent form, authorisation

**Policy**:
A patient's insurance cover with one payer: member ID, plan, employer, and annual benefit limit.
_Avoid_: membership, coverage

**Benefit code**:
An insurer's own code for a dental item on its claim form (for example Singlife "M01" crowns).
_Avoid_: insurer code, claim code

**Pre-authorisation**:
An insurer's approval before treatment, sometimes a Letter of Guarantee, carried on the claim as a reference.
_Avoid_: LOG (except when quoting a payer), approval letter

**Code map**:
The clinic's table from its own treatment codes to CHAS procedures, TOSP codes and each payer's benefit codes.
_Avoid_: crosswalk, code translation

**Rule set**:
One version of a scheme's rules (amounts, limits, windows, rankings) with its source and effective date, chosen by visit date.
_Avoid_: schedule (used only for the CHAS subsidy table inside a rule set), policy

**Benchmark**:
MOH's fee range for a CHAS dental procedure. A fee above it needs a clinical justification on the claim.
_Avoid_: fee cap, guideline price

## Claims

**Bill split**:
How one visit's fee divides across the payers and the patient balance, shown as one bar.
_Avoid_: breakdown, allocation

**Patient balance**:
What is left of a visit's fee after the payer waterfall; the patient pays it.
_Avoid_: co-pay (that is a policy term), out-of-pocket

**Payer waterfall**:
The order payers are asked within one visit (by default CHAS, then MediSave, then insurance), each claiming from what the payer above it left; the patient pays the balance.
_Avoid_: coordination of benefits, split billing

**Claim**:
A request to one payer for part of one source visit, made of claim lines.
_Avoid_: submission (that's the act of sending), case, transaction

**Claim line**:
One treatment as it appears on a claim: the scheme's code, the fee considered, and the amount claimed.
_Avoid_: item, row

**Finding**:
Something a check found about a claim. A blocking finding stops the claim; a warning doesn't.
_Avoid_: error, issue, validation message

**Approval**:
A reviewer's sign-off that a claim may be submitted. Cleared if the claim changes before it goes.
_Avoid_: "approved" for anything a payer does (that is **accepted**)

**Accepted amount**:
What the payer agreed to pay on a claim; at most the amount claimed.
_Avoid_: approved amount, settled amount

**Submission attempt**:
One sending of a claim to its payer. A resubmitted claim keeps its identity and gains an attempt.
_Avoid_: resubmission claim, new claim

**Portal refusal**:
The payer's portal turns an approved claim away before it issues a portal reference. The claim counts as rejected.
_Avoid_: submission error, failed submit

**Recorded payment**:
Money a payer has paid against a claim, recorded by hand or from a remittance. A claim is paid once its recorded payments reach the accepted amount; a payment on a claim nobody marked accepted accepts it at the amount paid.
_Avoid_: settlement, "pay" as an action name

**Short payment**:
A payer paid less than the accepted amount. Someone closes it on purpose, with a reason; the claim becomes paid and the difference is written off.
_Avoid_: partial payment (a part payment may still be followed by the rest), underpayment

**Overpaid**:
A paid claim whose recorded payments exceed the accepted amount. It stays paid and is flagged for a person.
_Avoid_: credit, surplus

**Withdraw**:
The clinic decides not to submit a claim. Not the same as a MediSave withdrawal limit.
_Avoid_: cancel, void

**Write off**:
The clinic gives up on a rejected claim or on the unpaid part of an accepted one. Accepting a short payment writes off the difference.
_Avoid_: close, abandon

**Claim packet**:
Everything a person or channel needs to submit one claim, in the payer's order, holding only the fields that payer needs.
_Avoid_: payload, form data

**Submission channel**:
How claims reach a payer: assisted (a person keys the packet into the payer's portal), file (a batch file in the payer's layout), API, or simulator.
_Avoid_: adapter (that's the code), integration, connector

**Portal reference**:
The claim number the payer's portal gives back when a claim is submitted.
_Avoid_: claim ID, transaction number

**Payer simulator**:
The claims desk's own stand-in payer, used to demonstrate and test the lifecycle without a real portal.
_Avoid_: mock portal, sandbox

**Changed after submission**:
A submitted claim whose source visit has since been re-imported with different details. The claim is left as sent and flagged for a person. A person clears the flag by acknowledging the change, with a note.
_Avoid_: stale, out of sync

**Remittance**:
A payer's statement of what it paid, imported to match payments to claims.
_Avoid_: settlement, payment file

**Claims officer**:
The person who imports, fixes, submits and records outcomes.
_Avoid_: admin, clerk, user

**Reviewer**:
The person who approves claims before they're submitted.
_Avoid_: approver, manager

## Data handling

**Synthetic identifier**:
An NRIC/FIN made up for test and demo data, always in the `T9` block (birth years 2090 to 2099, so none can have been issued) with a valid check letter.
_Avoid_: fake NRIC, test NRIC

**Synthetic phone number**:
A phone number made up for test and demo data, always `+65 0000 nnnn`. No Singapore number starts with 0, so none can belong to anyone. A test that needs a real local shape (eight digits starting 6, 8 or 9) builds it at run time and never writes one down.
_Avoid_: fake number, dummy number

**De-identified text**:
Treatment text, codes and amounts with every identifier removed; the only patient-related data the AI features see.
_Avoid_: anonymised, masked

**Identifier key**:
The secret (`IDENTIFIER_KEY`) that keys every patient hash and seals each visit's identity. Rotated in place, never simply replaced.
_Avoid_: encryption key, master key

**Key version**:
The identifier key's whole-number version (`IDENTIFIER_KEY_VERSION`), carried as a `v<n>:` prefix on every stored hash and seal, and stored on each statement and statement line as the version it was taken in under.
_Avoid_: key ID, key generation

**Previous key**:
The identifier key one version back (`IDENTIFIER_KEY_PREVIOUS`), set only while a rotation is under way so rows under it still open and still match.
_Avoid_: old key, backup key

**Reseal**:
Moving stored visit revisions, and the patient hashes that go with them, from the previous key to the current one, a batch at a time, by a reviewer. A revision may be re-keyed, never changed.
_Avoid_: re-encrypt, migrate keys

**Possible duplicate**:
A payment statement with the same payer, file name and number of lines as one imported under an earlier key version. The desk refuses it until a reviewer confirms it is a different file.
_Avoid_: duplicate file, double import
