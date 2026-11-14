# Code review 05: the connector

- **Branch:** `crew/chas-claimer-05-connector` at `03b018c`
- **Compared against:** `crew/chas-claimer` at its merge-base `f7d00b5` (`git diff crew/chas-claimer...crew/chas-claimer-05-connector`)
- **Size:** 7 commits, 17 files, +1654/-8
- **Spec:** `issues/05-connector.md` (including the conductor addendum), AC-7.1 to AC-7.5 in `reviews/functional.md`, technical §3, F7 and §7, decisions-g2 §15, and the ADR 0006 amendment
- **Reviewed:** 2026-11-14

## Verdict: changes-requested

There is one blocking finding. On a CSV export with no header row, `describe` prints the first row of patient data as if those values were column names. The ticket says "`describe` prints table and column names only, never rows". I reproduced the problem (see S-1). Everything else is should fix or nit. The rest of the branch is solid:

- Tokens come only from the environment and are never printed.
- https is enforced, except on loopback.
- Redirects are not followed.
- A request sends both the Access pair and the bearer token.
- Refusals are not retried.
- Pages hold at most 100 visits.
- Every CHAS card row goes into `chasCards`.
- Notes and pre-auth references reach the sealed identity.
- AC-7.1 to AC-7.5 each have an end-to-end test against the real import handler.

## Verification

| Command (in the worktree) | Result |
|---|---|
| `npm install` | 0 vulnerabilities |
| `npx vitest run` | 49 files, 485 tests passed (React `act()` warnings only) |
| `npm run typecheck` | clean |
| `npm run build` | ok |
| Probe: `run(["describe", "--source", <folder>])` on a `patients.csv` with no header row, whose first row is a synthetic visit key, a T-prefix NRIC, a name and a date | exit 0. Prints `patients: V-1, T9…, Test Patient Sentinel, 2026-11-01` (the synthetic NRIC is shortened here) |

- **Blocked paths:** the diff does not touch `src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars` or `dist/`. `package.json` is unchanged, and only the README section "Running the connector at the clinic" changed.
- **UI:** none in the diff, so the web design review does not apply.

## Standards

No hard violations. The connector uses `SourceMapping` and `SourceSchema` from `src/domain/source-mapping.ts` and defines no mapping shape of its own. Tests reach the network only through `stubNetwork`. Synthetic data only. The README section is in sentence case and second person, with no buzzwords and no exclamation marks.

### Should fix

- **ST-1. `connector/mapping.ts:155-162`: `dollars()` duplicates `parseDollars` (`src/domain/money.ts:17`)**, and the two disagree.
  - Rule broken: reuse (the reviewer standard: no new code that duplicates an existing helper).
  - `parseDollars` accepts thousands separators and checks for a safe integer. `dollars()` does neither, and it accepts a minus sign.
  - So a clinic export with `1,234.50` in a dollars column is passed through as a string. The schema then refuses the row, although the desk's own parser reads that value.
  - Fix: use `parseDollars`, and pass the raw value through only when it fails, so the schema still names the problem.
- **ST-2. `connector/post.ts:121`: `LOOPBACK` repeats `LOCAL_HOSTS` in `server/auth.ts:18`.** Rule broken: reuse.
  - The two sets hold the same hosts and serve the same purpose ("this machine, never the deployed desk").
  - Fix: share one hostname predicate, so a future change to the loopback list cannot drift between the desk and the connector.

### Nit

- **ST-3. `connector/cli.ts:252`:** the text "after 3 retries" is hard-coded, while the actual count is `BACKOFF_MS.length` (`post.ts:41`). Derive the text from that length.
- **ST-4. `connector/mapping.ts:56` and `:178`:** these inline date regexes partly repeat `parseIsoDate` (`src/domain/dates.ts:12`). The schema still validates the dates, so this is cosmetic.
- **ST-5. `connector/test-support.ts:18-33`:** this hand-rolls CSV quoting that `toCsv` (`src/domain/csv.ts:21`) already does.
- **ST-6. `connector/cli.ts:23`:** the connector imports `visitOrder` from `server/services/imports`, which makes the clinic-side tool depend on a server module. Consider moving `visitOrder` into `src/domain/`.
- **ST-7. Unclear names:**
  - `ms`, `m`, `p`, `v`, `x` in `mapping.ts:69-107`.
  - `read`, used for a closure at `mapping.ts:27` and for a loop variable at `cli.ts:164`.
  - `Located` (`cli.ts:155`) and `Answer` (`post.ts:80`).

## Spec

### Blocking

- **SP-1 / S-1. `connector/sources/csv.ts:36-37` with `connector/cli.ts:151`: `describe` prints row values when a CSV export has no header row.**
  - Spec line broken: ticket 05, "`describe` prints table and column names only, never rows". The brief adds that no row or identifier is to be printed on any path.
  - Cause: `openCsv` always takes the first record as the header, and `describeSource` prints it as-is. A hand-kept export without a header row (the tests themselves allow for hand-kept exports) puts a patient's NRIC, name and date on the operator's screen. From there it can easily end up in a support message to Jura.
  - Reproduced with a synthetic file (see Verification).
  - Fix: before printing, check each header cell against the shape of a column name. For example, refuse a header cell that looks like an NRIC/FIN, a date, a phone number or a bare number, and say "the first line of patients.csv does not look like column names" without echoing it. Alternatively, print a header cell only when it matches a plain identifier pattern, and replace any other cell with "(column N)".
  - Add a test with a headerless file whose first row holds sentinel values, asserting that none of them is printed. Apply the same guard on the `dry-run`/`push` path: there `checkColumns` already names only the mapping's columns, so no values are printed today, but the guard gives the operator a clearer message.

### Should fix

- **SP-2. `connector/cli.test.ts:126-132`: the end-to-end leak check does not cover the ADR 0006 amendment.**
  - Spec line: addendum and ADR 0006, "notes and pre-auth references go to the sealed identity".
  - The test checks only NRIC, name and phone in `clinical_json`. The routing is correct: `splitVisit` in `src/domain/source-visit.ts` handles it, and that file is unchanged in this diff. But nothing here proves that a mapped note or pre-auth reference stays out of `clinical_json` once it has gone through the connector.
  - Fix: use `recordsWithPreAuth()` in that test and assert that every note text and `PAREF-TEST-*` reference is absent.

### Nit

- **SP-3. AC-7.5 is read per page, not per run.** Each page is its own import, so a failure on page 2 leaves page 1 recorded as a finished import (`cli.test.ts:179` asserts this).
  - This is consistent with F7 (each `/api/imports` call is one import), and the README explains it.
  - The AC text says "no partial import recorded as complete". Each import record is whole, and a rerun is idempotent, so I accept this reading. The QA lead should confirm it at the gate.
- **SP-4. `connector/post.ts:71-74`: a deliberate 503 `auth_not_configured` (`server/http.ts:94`) is retried three times and then reported as "Could not reach the desk".**
  - Fix: treat a 5xx that carries a desk error code other than an internal error as a refusal, and name the code.
- **SP-5. `connector/post.ts:139-156`: the Access pair is optional ("both or neither").**
  - decisions-g2 §15 says the connector sends the Access service token. In practice a remote desk without the pair gets a 302 from Access, which the connector reports by naming the `CF_ACCESS_*` variables (test at `cli.test.ts:222`). This is safe.
  - Optional is reasonable for loopback development. Consider requiring the pair for any host that is not loopback.
- **SP-6. S7 edge:** a voided row that also fails `parseSourceVisit` is skipped at the clinic, so its void never reaches the desk. The connector reports the row as skipped, so the operator sees it. Note only.
- **SP-7. Mapping field `visits.fields.billedAmount` (`src/domain/source-mapping.ts:44`) is accepted but `readVisits` ignores it.** Nothing downstream reads `billedCents` today. Either map it or refuse a mapping that sets it, so a clinic is not misled.
- **SP-8. README, "Running the connector at the clinic", `CLAIMS_DESK_URL` row:** it says plain `http` is allowed only for `localhost`. The code also allows `127.0.0.1` and `[::1]`.

### Scope

- `src/domain/csv.ts` gains `parseCsvRecords` with line numbers. This file sits outside `connector/`, but AC-7.4 needs it, and the change only adds to the file. Accepted.
- The https and loopback check, the 3xx-as-Access-refusal rule, the 60 s timeout and the "pre-auth with no matching policy" problem were not asked for. They are small and they make the connector safer. Accepted.

## Security

The `security-review` skill could not run here: it needs `origin/HEAD`, and the review cwd is not a git checkout. I did the pass by hand on the same diff.

### Blocking

- **S-1.** Same as SP-1: row values reach the terminal through `describe` on a headerless CSV.

### Should fix

None beyond S-1.

### Nit

- **S-2. `connector/cli.ts:234` and `:248`:** the desk's `issue.path`, `issue.message` and error `code` are printed verbatim.
  - The desk's messages come from the zod schema and carry no values (checked in `src/domain/source-visit.ts` and `server/services/imports.ts:80`), so this is safe against the real desk.
  - A wrong `CLAIMS_DESK_URL` could still print arbitrary text to the terminal. Stripping control characters before printing would close that.
- **S-3. `connector/post.ts:64`:** a 60 s timeout followed by a retry can overlap an import that is still running on the desk. Safety then rests on the desk's unique visit key and content hash. Note only.

### Checked and clean

- **Secrets.**
  - `CONNECTOR_TOKEN` and the `CF_ACCESS_*` pair are read only from the environment (`post.ts:127-157`).
  - Error messages name variables, never values (`post.test.ts:94`).
  - The token never appears in output (`cli.test.ts:153`).
  - The main catch prints only a fixed message (`cli.ts:266`).
- **Transport.**
  - https is required, with http allowed only on loopback.
  - Credentials, query and fragment are refused in the URL.
  - `redirect: "manual"` means headers never follow a redirect to another host (`post.ts:63`).
- **Retries.** These happen only on a network error or a 5xx. A 4xx, a 3xx or an Access page is not retried (`post.test.ts:60-80`).
- **Identifiers in output.**
  - Skipped-row lines give only the location, the field path and a schema message.
  - Driver errors are not echoed (`cli.ts:141-146`).
  - The CSV parse error gives only the record number (`csv.ts:33`).
  - `dry-run` masks every field that `splitVisit` seals: NRIC, name, phone, date of birth, address, notes, member ID, pre-auth reference and the account holder's NRIC. It also masks the employer (`cli.ts:188-210`).
- **SQL.** The SQLite reader quotes identifiers that come from the mapping. Values are never put into SQL.
- **Resource limits.** CSV files are capped at 1,000,000 rows. The desk caps pages at 100 (413 above that).
