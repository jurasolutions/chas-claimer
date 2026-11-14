import { useEffect, useState } from "react";
import type { ClaimDetail as Detail } from "../../api/claim-detail";
import { describeFinding, describeVisitNote } from "../../domain/claims/findings";
import type { IsoDate } from "../../domain/dates";
import type { ClaimActionKind, FindingCode } from "../../domain/types";
import { UNSENT_STATUSES } from "../../domain/claims/state";
import { cents, formatSgd, subtract } from "../../domain/money";
import { Alert, Button, Card } from "../../ds";
import { RejectionExplainer } from "../ai";
import { api, ApiError } from "../api";
import { BillSplit } from "../components/BillSplit";
import { ClaimActions } from "../components/ClaimActions";
import { ClaimAnnotations } from "../components/ClaimAnnotations";
import { ClaimHistory } from "../components/ClaimHistory";
import { ClaimSubmissions } from "../components/ClaimSubmissions";
import { DeadlineText } from "../components/DeadlineText";
import { FindingList } from "../components/FindingList";
import { MaskedIdentifier } from "../components/MaskedIdentifier";
import { PageHeader } from "../components/PageHeader";
import { MoneyCell } from "../components/MoneyCell";
import { StatusBadge } from "../components/StatusBadge";
import { useFocusOnSettle } from "../focus";
import { formatDate, formatDateTime } from "../format";
import { Link } from "../router";

export interface ClaimDetailProps {
  /** From the path `/claims/:id`. */
  claimId: string;
}

/** Why the claim didn't load: no access, no such claim, or anything else (worth another try). */
type LoadFailure = "forbidden" | "not_found" | "failed";

type Load = { state: "loading" } | { state: "failed"; why: LoadFailure } | { state: "ready"; detail: Detail };

function loadFailureOf(error: unknown): LoadFailure {
  if (error instanceof ApiError && error.status === 403) return "forbidden";
  if (error instanceof ApiError && error.status === 404) return "not_found";
  return "failed";
}

const detailPath = (id: string) => `/api/claims/${encodeURIComponent(id)}`;

/** Findings no edit can clear: the payer will never pay the claim, so the fix is to withdraw it (S8). */
const UNCLAIMABLE: ReadonlySet<FindingCode> = new Set<FindingCode>(["chas_green_no_dental", "card_expired", "past_submission_window"]);

/** What to do when the claim can never be paid, under its findings, when withdrawing is on offer. */
function WithdrawFix({ detail, onWithdraw }: { detail: Detail; onWithdraw: () => void }) {
  if (!detail.actions.includes("withdraw")) return null;
  if (!detail.claim.findings.some((f) => UNCLAIMABLE.has(f.code))) return null;
  return (
    <div className="finding-fix retry-line">
      <p>The payer won't pay this claim. Withdraw it, with your reason, to take it off the list.</p>
      <Button variant="secondary" size="sm" onClick={onWithdraw}>
        Withdraw this claim
      </Button>
    </div>
  );
}

/**
 * What the build said about the visit rather than this claim (D02): a line held until it's
 * complete, a payer with no claim and why, a withdrawn claim the desk doesn't build again, sent
 * claims that now pass the fee, and warnings that belong to no one claim. They don't stop this
 * claim (what stops it is in its own findings), so they carry no severity.
 */
function AboutVisit({ visit }: { visit: Detail["visit"] }) {
  if (visit.notes.length === 0 && visit.findings.length === 0) return null;
  return (
    <section className="claim-detail__visit" aria-labelledby="claim-visit">
      <h3 id="claim-visit">About this visit</h3>
      <ul className="claim-detail__remarks">
        {visit.notes.map((note, i) => (
          <li key={`note-${note.code}-${i}`}>{describeVisitNote(note)}</li>
        ))}
        {visit.findings.map((f, i) => (
          <li key={`finding-${f.code}-${i}`}>{describeFinding(f)}</li>
        ))}
      </ul>
    </section>
  );
}

/** The amount the claim asks for, the payer beside it: the first thing the page says. */
function ClaimAmount({ detail }: { detail: Detail }) {
  return (
    <span className="claim-amount">
      <span className="claim-amount__value money">{formatSgd(detail.claim.claimedCents)}</span>
      <span className="claim-amount__payer" translate="no">from {detail.payerName}</span>
    </span>
  );
}

const dash = (value: string | null) => value ?? "—";

/**
 * What a person needs to know about where the claim stands, beyond its status: who is submitting
 * it (S6), a change after submission (S7), the payer's rejection, and how much has been paid (B2).
 */
function ClaimStanding({ claim }: { claim: Detail["claim"] }) {
  const accepted = claim.acceptedCents;
  const short = claim.status === "accepted" && accepted !== null && claim.paidCents > 0 && claim.paidCents < accepted;
  // A claim closed by a short payment, or accepted by a smaller payment, still shows what it claimed (QA N8).
  const closedShort = claim.status === "paid" && claim.paidCents < claim.claimedCents;
  return (
    <>
      {claim.checkoutBy && claim.checkoutUntil ? (
        <Alert tone="info" title={`Being submitted by ${claim.checkoutBy} until ${formatDateTime(claim.checkoutUntil)}`} />
      ) : null}
      {claim.changedAfterSubmission ? (
        <Alert tone="warning" title="The visit changed after this claim was submitted">
          Amend or cancel it in the payer's portal if it needs it, then acknowledge the change here with a note.
        </Alert>
      ) : null}
      {claim.status === "rejected" ? (
        <Alert tone="danger" title="The payer rejected this claim">
          {claim.rejectionReason ? <p>{claim.rejectionReason}</p> : null}
          <RejectionExplainer claimId={claim.id} />
        </Alert>
      ) : null}
      {short ? (
        <p className="claim-detail__paid">
          Paid {formatSgd(claim.paidCents)} of {formatSgd(accepted)}
        </p>
      ) : null}
      {closedShort ? (
        <p className="claim-detail__paid">
          Paid {formatSgd(claim.paidCents)}, {formatSgd(subtract(claim.claimedCents, claim.paidCents))} short of the {formatSgd(claim.claimedCents)} claimed
        </p>
      ) : null}
      {claim.overpaid && accepted !== null ? (
        <Alert tone="warning" title={`Overpaid by ${formatSgd(cents(claim.paidCents - accepted))}`} />
      ) : null}
    </>
  );
}

/**
 * What the claim asks for, line by line: the clinic's code, the scheme's, and the three amounts.
 * On a phone the table scrolls sideways in its own box, which a keyboard can focus and scroll.
 */
function LinesTable({ lines }: { lines: Detail["lines"] }) {
  return (
    <div className="table-scroll" role="region" aria-labelledby="claim-lines" tabIndex={0}>
      <table className="claim-lines">
        <caption id="claim-lines">Lines</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Clinic code</th>
            <th scope="col">Scheme code</th>
            <th scope="col">Tooth</th>
            <th scope="col" className="num">
              Qty
            </th>
            <th scope="col" className="num">
              Fee
            </th>
            <th scope="col" className="num">
              Considered
            </th>
            <th scope="col" className="num">
              Claimed
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.lineNo}>
              <td>{line.lineNo}</td>
              <td>
                <code className="literal" translate="no">{dash(line.clinicCode)}</code>
              </td>
              <td>
                <code className="literal" translate="no">{dash(line.schemeCode)}</code>
              </td>
              <td>{dash(line.tooth)}</td>
              <td className="num">{line.quantity}</td>
              <td className="num">
                <MoneyCell cents={line.feeCents} />
              </td>
              <td className="num">
                <MoneyCell cents={line.consideredCents} />
              </td>
              <td className="num">
                <MoneyCell cents={line.claimedCents} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Who the claim is for: masked until someone asks, and every reveal is recorded (AC-3.5). */
function PatientCard({ claim, branchName }: { claim: Detail["claim"]; branchName: string }) {
  return (
    <section className="claim-detail__patient" aria-labelledby="claim-patient">
      <h3 id="claim-patient">Patient</h3>
      <dl className="claim-facts">
        <dt>NRIC/FIN</dt>
        <dd>
          <MaskedIdentifier claimId={claim.id} field="nric" masked={claim.patientMask} label="NRIC/FIN" />
        </dd>
        <dt>Visit</dt>
        <dd>
          {formatDate(claim.visitDate)} <span className="muted">at {branchName}</span>
        </dd>
      </dl>
    </section>
  );
}

/** How the visit's fee splits across payers, and the visit's other claims (AC-3.7). */
function WhoPays({ detail }: { detail: Detail }) {
  return (
    <section className="claim-detail__pays" aria-labelledby="claim-pays">
      <h3 id="claim-pays">Who pays</h3>
      {detail.frozenOn ? (
        <p className="muted">As built on {formatDate(detail.frozenOn)}. Later changes to the visit don't change these figures.</p>
      ) : null}
      <BillSplit segments={detail.split.segments} feeCents={detail.split.feeCents} size="detail" highlightClaimId={detail.claim.id} />
      {detail.pricedBy.length ? (
        <>
          <p className="muted" id="claim-priced">
            How each scheme priced its share
          </p>
          <ul className="claim-detail__priced" aria-labelledby="claim-priced">
            {detail.pricedBy.map((priced) => (
              <li key={priced.payerId}>
                <span translate="no">{priced.payerName}</span>: <code className="literal" translate="no">{priced.ruleSet.id}</code>, from{" "}
                {priced.ruleSet.sources.map((source, i) => (
                  <span key={source.url}>
                    {i > 0 ? ", " : null}
                    <SourceLink url={source.url} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {detail.siblings.length ? (
        <>
          <p className="muted">Other claims for this visit</p>
          <ul className="claim-siblings">
            {detail.siblings.map((sibling) => (
              <li key={sibling.id}>
                <Link href={`/claims/${encodeURIComponent(sibling.id)}`}>
                  <span translate="no">{sibling.payerName}</span> <span className="money">{formatSgd(sibling.claimedCents)}</span>
                </Link>{" "}
                <StatusBadge status={sibling.status} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** A rule set's source, opened in a new tab and shown without its scheme. */
function SourceLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" translate="no">
      {url.replace(/^https:\/\//, "")}
    </a>
  );
}

/** Which visit revision the claim was built from, and the visit's revision now. */
function BuiltFrom({ revision }: { revision: Detail["revision"] }) {
  return (
    <p className="muted">
      Built from visit revision {revision.builtFrom}.
      {revision.current !== revision.builtFrom ? ` The visit is now at revision ${revision.current}.` : ""}
    </p>
  );
}

/**
 * Where the amounts came from: the rule set, its sources and when each was read (AC-3.7). An insurer's
 * claim isn't priced by a scheme rule set, so it shows only the revision it was built from (D13).
 */
function RuleSetCard({ ruleSet, revision, scheme }: { ruleSet: Detail["ruleSet"]; revision: Detail["revision"]; scheme: Detail["claim"]["scheme"] }) {
  if (!ruleSet && scheme === "insurance") {
    return (
      <div className="claim-detail__rules">
        <BuiltFrom revision={revision} />
      </div>
    );
  }
  return (
    <section className="claim-detail__rules" aria-labelledby="claim-rules">
      <h3 id="claim-rules">Rule set</h3>
      {ruleSet ? (
        <>
          <p>
            <code className="literal" translate="no">{ruleSet.id}</code>{" "}
            <span className="muted">
              In force from {formatDate(ruleSet.effectiveFrom as IsoDate)}
              {ruleSet.effectiveTo ? ` to ${formatDate(ruleSet.effectiveTo as IsoDate)}` : ""}
            </span>
          </p>
          <ul className="claim-detail__sources">
            {ruleSet.sources.map((source) => (
              <li key={source.url}>
                <SourceLink url={source.url} />{" "}
                <span className="muted">Read on {formatDate(source.retrieved as IsoDate)}</span>
              </li>
            ))}
          </ul>
          {ruleSet.note ? <p className="muted">{ruleSet.note}</p> : null}
        </>
      ) : (
        <p className="muted">No rule set covered this visit.</p>
      )}
      <BuiltFrom revision={revision} />
    </section>
  );
}

/**
 * One claim (block 04). The server sends everything the page shows, worked out for this viewer:
 * the deadline in days, the actions on offer, the bill split. On a phone the findings come first;
 * from 1024px the claim sits on the left and the findings and history on the right.
 */
export function ClaimDetail({ claimId }: ClaimDetailProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // Bumped to fetch the claim again in place, keeping what is on screen until the answer lands.
  const [reads, setReads] = useState(0);
  // The action dialog that is open: the actions and the withdraw fix under the findings share it.
  const [asking, setAsking] = useState<ClaimActionKind | null>(null);
  // Counts the actions that went through. Each one replaces the button that ran it, so focus goes
  // to the status line, which says what the claim is now (QA N1).
  const [acted, setActed] = useState(0);
  const statusRef = useFocusOnSettle<HTMLDivElement>(acted);

  useEffect(() => {
    let current = true;
    api.get<Detail>(detailPath(claimId)).then(
      (detail) => current && setLoad({ state: "ready", detail }),
      (error: unknown) => current && setLoad({ state: "failed", why: loadFailureOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [claimId, reads]);

  if (load.state === "loading") {
    return (
      <>
        <PageHeader title="Claim" />
        <p className="muted" role="status">
          Loading the claim…
        </p>
      </>
    );
  }

  if (load.state === "failed") {
    return (
      <>
        <PageHeader title="Claim" />
        <Alert tone="danger" role="alert" title="The claim didn't load.">
          {load.why === "forbidden" ? (
            "Your account isn't on the desk's team list. Ask the clinic's administrator to add you."
          ) : load.why === "not_found" ? (
            <>
              There is no claim at this address. <Link href="/claims">Back to the claims</Link>
            </>
          ) : (
            <span className="retry-line">
              Check your connection, then try again.
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setLoad({ state: "loading" });
                  setReads((n) => n + 1);
                }}
              >
                Try again
              </Button>
            </span>
          )}
        </Alert>
      </>
    );
  }

  const { detail } = load;
  const { claim } = detail;
  const show = (next: Detail) => setLoad({ state: "ready", detail: next });
  const afterAction = (next: Detail) => {
    show(next);
    setActed((n) => n + 1);
  };
  const reload = () => setReads((n) => n + 1);
  const unsent = UNSENT_STATUSES.has(claim.status);
  // A rejected claim can be reopened and fixed, so its findings are still things to fix (D07, D17).
  const settled = !unsent && claim.status !== "rejected";
  const blocked = unsent && claim.findings.some((f) => f.severity === "blocking");
  return (
    <>
      <PageHeader title={<ClaimAmount detail={detail} />} />
      <div ref={statusRef} tabIndex={-1} className="claim-detail__status settled-focus">
        <StatusBadge status={claim.status} />
        {detail.deadline ? <DeadlineText {...detail.deadline} /> : null}
        {blocked ? <span className="claim-detail__blocked">This claim can't be submitted until its blocking findings are fixed.</span> : null}
      </div>
      <ClaimStanding claim={claim} />
      <ClaimActions detail={detail} onDone={afterAction} onReload={reload} open={asking} onOpen={setAsking} />
      <div className="claim-detail">
        <section className="claim-detail__findings" aria-labelledby="claim-findings">
          <h2 id="claim-findings">{settled ? "What the checks found" : "What to fix"}</h2>
          <FindingList findings={claim.findings} describe={describeFinding} settled={settled} />
          <WithdrawFix detail={detail} onWithdraw={() => setAsking("withdraw")} />
          <AboutVisit visit={detail.visit} />
        </section>
        <section className="claim-detail__history" aria-labelledby="claim-history">
          <h2 id="claim-history">History</h2>
          <ClaimHistory events={detail.audit} />
        </section>
        <ClaimSubmissions submissions={detail.submissions} />
        <section className="claim-detail__claim" aria-labelledby="claim-claim">
          <h2 id="claim-claim">The claim</h2>
          <Card>
            <PatientCard claim={claim} branchName={detail.branchName} />
            <WhoPays detail={detail} />
            <ClaimAnnotations key={claim.id} detail={detail} onDone={show} onReload={reload} />
            <LinesTable lines={detail.lines} />
            <RuleSetCard ruleSet={detail.ruleSet} revision={detail.revision} scheme={claim.scheme} />
          </Card>
        </section>
      </div>
    </>
  );
}
