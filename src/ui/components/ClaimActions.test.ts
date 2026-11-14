import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { failureOf } from "./ClaimActions";

describe("failureOf", () => {
  it("names the portal reference another claim to this payer already carries (S6, AC-4.3)", () => {
    const failure = failureOf(new ApiError(409, "reference_taken", { error: "reference_taken", portalReference: "MHCP-0001" }));

    expect(failure).toEqual({
      message: "MHCP-0001 is already on another claim to this payer. Check the reference the portal gave you.",
      reload: false,
    });
  });

  it("gives the server's reason and the field it names when what was entered is refused", () => {
    const failure = failureOf(
      new ApiError(400, "invalid", { error: "invalid", issues: [{ path: "reason", message: "Say why the claim is withdrawn." }] }),
    );

    expect(failure).toEqual({ message: "Say why the claim is withdrawn.", field: "reason", reload: false });
  });

  it("falls back to plain words when a refusal carries no reason", () => {
    expect(failureOf(new ApiError(400, "invalid", { error: "invalid" }))).toEqual({
      message: "Check what you entered and try again.",
      reload: false,
    });
  });
});
