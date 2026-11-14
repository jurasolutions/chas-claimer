import { createD1 } from "./helpers/d1";

test("the in-memory D1 answers a query", async () => {
  const db = await createD1({ migrate: false });
  expect(await db.prepare("select 1 + 1 as two").first("two")).toBe(2);
});
