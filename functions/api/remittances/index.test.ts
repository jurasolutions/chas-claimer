import type { Env } from "../../../server/env";
import type { RemittanceListItem, RemittanceSummary } from "../../../src/api/remittances";
import { nricCheckLetter } from "../../../src/domain/nric";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { NOW, retiredDesk } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { awaitingPayment, claimOf, R1, R2 } from "../../../tests/helpers/payments";
import { onRequestGet, onRequestPost } from "./index";

const team = await accessTeam();
/** A well-formed NRIC outside the synthetic T9 block. */
const OUTSIDE_BLOCK = `T8999999${nricCheckLetter("T", "8999999")}`;
const CHAS_HEADER = "reference,identifier,visit date,amount";
const HARBOUR_COLUMNS = { reference: "Ref", patientNric: null, visitDate: "Date", amount: "Paid", paidOn: null };

async function upload(env: Env, json: unknown, email = OFFICER) {
  return call(onRequestPost, apiRequest("/api/remittances", { json, jwt: await team.sign(accessClaims(email)) }), env);
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/remittances", () => {
  it("imports R1 for an officer, pays what it matches, and answers the counts without an identifier", async () => {
    const { env, db } = await awaitingPayment();

    const res = await upload(env, R1);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ outcome: "imported", lines: 5, matched: 3, forPerson: 2 } satisfies Partial<RemittanceSummary>);
    expect(text).not.toMatch(/[STFGM]\d{7}[A-Z]/);
    expect(await claimOf(db, "SC-D01", "CHAS")).toMatchObject({ status: "paid" });
  });

  it("AC-5.6: answers already imported with nothing added when R1 comes again, and changes no claim", async () => {
    const { env, db } = await awaitingPayment();
    const first = (await (await upload(env, R1)).json()) as { remittanceId: string };
    const d01 = await claimOf(db, "SC-D01", "CHAS");

    const again = await upload(env, R1);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ outcome: "already_imported", remittanceId: first.remittanceId, added: 0 });
    expect(await claimOf(db, "SC-D01", "CHAS")).toEqual(d01);
  });

  it("AC-5.7: answers empty for a file with headers only", async () => {
    const { env } = await awaitingPayment();

    const res = await upload(env, { ...R1, fileName: "empty.csv", csv: `${CHAS_HEADER}\r\n` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "empty" });
  });

  it("answers 409 columns not mapped for a payer no reviewer has mapped", async () => {
    const { env } = await awaitingPayment();

    const res = await upload(env, { payerId: "HARBOUR", fileName: "h.csv", csv: "Ref,Date,Paid\r\n" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "columns_not_mapped", payerId: "HARBOUR" });
  });

  it("saves a reviewer's columns with the upload, and refuses them from an officer with 403", async () => {
    const { env } = await awaitingPayment();
    const harbour = { payerId: "HARBOUR", fileName: "h.csv", csv: "Ref,Date,Paid\r\n", columns: HARBOUR_COLUMNS };

    const officer = await upload(env, harbour);
    const reviewer = await upload(env, harbour, REVIEWER);

    expect(officer.status).toBe(403);
    expect(reviewer.status).toBe(200);
    expect(await reviewer.json()).toEqual({ outcome: "empty" });
  });

  it("answers 422 naming the missing header, never a value from the file", async () => {
    const { env } = await awaitingPayment();

    const res = await upload(env, { ...R1, csv: "reference,identifier,amount\r\nMHCP-0001,,50.50\r\n" });

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "statement_unreadable", problem: { kind: "missing_columns", headers: ["visit date"] } });
    expect(text).not.toContain("MHCP-0001");
  });

  it("answers 422 naming the line that carries an NRIC outside the synthetic block, never the NRIC", async () => {
    const { env } = await awaitingPayment();

    const res = await upload(env, { ...R1, csv: `${CHAS_HEADER}\nMHCP-0001,,2026-11-03,50.50\nMHCP-0009,${OUTSIDE_BLOCK},2026-11-03,12.00\n` });

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "real_identifier_refused", lines: [2] });
    expect(text).not.toContain(OUTSIDE_BLOCK.slice(1, 8));
  });

  it("answers 400 on the payer ID for a payer the desk does not have", async () => {
    const { env } = await awaitingPayment();

    const res = await upload(env, { ...R1, payerId: "NOBODY" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid", issues: [{ path: "payerId" }] });
  });

  it("refuses a person on neither role list", async () => {
    const { env } = await awaitingPayment();

    expect((await upload(env, R1, STRANGER)).status).toBe(403);
  });

  describe("a statement that looks like one taken in under a retired key (review B1)", () => {
    async function retiredAfterR1() {
      const desk = await awaitingPayment();
      const first = (await (await upload(desk.env, R1)).json()) as { remittanceId: string };
      return { env: (await retiredDesk(desk)).env, earlierId: first.remittanceId };
    }

    it("answers 409 possible duplicate naming the earlier statement", async () => {
      const { env, earlierId } = await retiredAfterR1();

      const res = await upload(env, R1);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "possible_duplicate", remittanceId: earlierId });
    });

    it("takes a reviewer's confirmation and refuses an officer's with 403", async () => {
      const { env } = await retiredAfterR1();

      const officer = await upload(env, { ...R1, confirmPossibleDuplicate: true });
      const reviewer = await upload(env, { ...R1, confirmPossibleDuplicate: true }, REVIEWER);

      expect(officer.status).toBe(403);
      expect(await officer.json()).toMatchObject({ error: "forbidden", detail: "only a reviewer can import a possible duplicate" });
      expect(reviewer.status).toBe(200);
      expect(await reviewer.json()).toMatchObject({ outcome: "imported", lines: 5 });
    });

    it("answers 400 on a confirmation that is not true or false", async () => {
      const { env } = await awaitingPayment();

      const res = await upload(env, { ...R1, confirmPossibleDuplicate: "yes" });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid", issues: [{ path: "confirmPossibleDuplicate" }] });
    });
  });
});

describe("GET /api/remittances", () => {
  it("lists statements newest first with their counts", async () => {
    const { env } = await awaitingPayment();
    await upload(env, R1);
    vi.setSystemTime(NOW + 60_000);
    await upload(env, R2);

    const res = await call(onRequestGet, apiRequest("/api/remittances", { jwt: await team.sign(accessClaims(REVIEWER)) }), env);

    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: RemittanceListItem[] };
    expect(items.map((i) => [i.fileName, i.lines, i.matched])).toEqual([
      ["r2-meridian.csv", 1, 1],
      ["r1-chas.csv", 5, 3],
    ]);
  });
});
