# Design direction: Claims desk

Every screen is built from the Jura design system (`src/ds.ts`, tokens only, Lucide through
`src/lib/icons.ts`). This note decides what the design system leaves open for this product.

## Subject, audience, job

- **Subject:** a dental clinic's claims, from the itemised bill to each payer's payment.
- **Audience:** a clinic's claims officer at the front desk between patients, and the reviewer
  (practice manager or dentist-owner) approving a batch at the end of the day. Desktop at the
  desk, a phone for the reviewer.
- **Primary job:** see which claims need a person today, fix them, and get them out before the
  30-day window closes.

## The one memorable thing: the bill split

Every visit's fee is split across payers by the **payer waterfall**. The desk shows that split
as one horizontal bar, the **bill split**, sized by amount: CHAS, then MediSave, then the
insurer, then what the patient pays. It is the claim's signature, the same in three sizes:

- **Claim detail:** full width, 16px tall, every segment labelled underneath with payer and
  amount in tabular figures.
- **Queue row:** 6px tall under the patient line, no labels, the claim's own segment drawn
  solid and the others at low opacity, so the officer sees at a glance "this claim is the
  big middle piece of a visit".
- **Assisted submission:** at the top of the checklist, so the officer can see what the patient
  was told they pay.

Segments are distinguished by **position and pattern**, not colour alone: CHAS solid
`--green-700`, MediSave solid `--green-500`, insurer `--green-300`, patient `--neutral-200`
with a diagonal hatch. A screen reader gets the split as a sentence ("CHAS pays $462.50,
MediSave $400.00, patient pays $87.50 of $950.00").

Everything else is quiet.

## Tokens

| Role | Value |
|---|---|
| Page | `--white` (desk), `--surface-sunken` for the work area behind cards, nowhere else |
| Text | `--neutral-900` strong, `--neutral-700` body, `--neutral-500` muted |
| Brand / action | `--green-600` buttons, active nav, links |
| Bill split | `--green-700`, `--green-500`, `--green-300`, `--neutral-200` hatched, `--neutral-300` for the rest of the bill |
| Status | `Badge` tones only: warning for "needs attention", danger for "rejected" and "past deadline", success for "paid", info for "submitted" |

## Type

The design system's pair, used deliberately:

- **Outfit** for page titles and the amount on a claim's header. Amounts are the most
  important thing a claims officer reads, so the claim header puts the claimed amount in Outfit
  at `--text-h2`, with the payer as a plain sentence beside it ("from CHAS Blue").
- **DM Sans** for everything else, with `font-variant-numeric: tabular-nums` on every column of
  money and every date, right-aligned money.
- **IBM Plex Mono** only for things a person copies into a portal: portal references, codes
  (TOSP `SF810T`, benefit `M01`), masked NRIC. Mono there means "this is a literal value".
  No mono labels, no uppercase eyebrows.

## Layout

```
desktop ≥ 1024px
┌──────────┬───────────────────────────────────────────────┐
│ Claims   │  Today                       [Import visits]  │
│ desk     │  4 need attention, 12 ready, 3 due in 5 days   │
│          ├───────────────────────────────────────────────┤
│ Today    │  filter: scheme  status  branch      search    │
│ Claims   │  ┌─────────────────────────────────────────┐   │
│ Submit   │  │ ☐ Test P.  T••••018H   CHAS Blue  $462.50│   │
│ Payments │  │   ▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░▒▒   due in 4 days    │   │
│ Settings │  │ ☐ ...                                   │   │
│          │  └─────────────────────────────────────────┘   │
│ Payer    │                                               │
│ simulator│                                               │
└──────────┴───────────────────────────────────────────────┘

phone < 768px: top bar (logo, current section, menu); queue rows stack
name / amount on one line, split bar, then status and deadline.
```

- Left-aligned throughout. No centred hero; the first thing on **Today** is the sentence of
  counts, each count a link into the filtered queue.
- The queue is a list of rows separated by hairlines inside one card, not a grid of cards.
- The claim detail is two columns on desktop (claim on the left, findings and history on the
  right), one column on a phone with findings first.
- The payer simulator carries a persistent neutral banner: "Payer simulator. Nothing here
  reaches a real payer." It never uses MOH's, CPF's or any insurer's name or look.

## Principles

1. **Deadlines are words, not colours.** "Due in 4 days", "Past the 30-day window", with a
   badge tone added, never colour alone.
2. **Findings say what to do.** "The CHAS Orange card expired on 2 Oct, before this visit.
   Ask the patient for their new card, then re-import." Never "Validation failed".
3. **Identifiers are masked until you need them.** A reveal is a deliberate click, and it says
   it's recorded.
4. **One action per screen is primary.** Queue: approve selected. Claim: the next state.
   Assisted submission: "Record portal reference".
5. **Motion only answers an action.** A row leaving the queue after approval collapses; nothing
   animates on load. Reduced motion respected.

## Review against the brief

The first plan used a dashboard of KPI tiles on **Today** (claims this month, amount pending,
rejection rate). That is the default for any operations product, and the numbers would look
like evidence the clinic doesn't have yet. It was replaced by the sentence of counts that each
lead to work. The first plan also coloured each payer with a different hue; the design system
reserves colour for status, so the bill split uses one green ramp plus a hatch.
