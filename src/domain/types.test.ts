import { actorId } from "./types";

describe("actorId", () => {
  it("writes a person as their email and a system actor as system:<name>", () => {
    expect(actorId({ kind: "person", email: "reviewer@example.test", roles: ["reviewer"] })).toBe("reviewer@example.test");
    expect(actorId({ kind: "system", name: "remittance" })).toBe("system:remittance");
  });
});
