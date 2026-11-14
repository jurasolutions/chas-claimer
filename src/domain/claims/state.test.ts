import { describe, expect, it } from "vitest";
import type { ClaimStatus, Finding } from "../types";
import { findingsInForce } from "./state";

const SOON: Finding = { code: "deadline_approaching", severity: "warning", params: { daysLeft: 0 } };
const PAST: Finding = { code: "past_submission_window", severity: "blocking", params: {} };
const OTHER: Finding = { code: "pre_auth_missing", severity: "warning", params: {} };

describe("findingsInForce", () => {
  it.each<ClaimStatus>(["submitted", "accepted", "paid", "rejected", "withdrawn", "written_off"])(
    "N6: drops the submit-soon warning from a %s claim and keeps its other findings",
    (status) => {
      expect(findingsInForce(status, [OTHER, SOON, PAST])).toEqual([OTHER, PAST]);
    },
  );

  it.each<ClaimStatus>(["needs_attention", "ready", "approved"])("keeps the submit-soon warning on a %s claim", (status) => {
    expect(findingsInForce(status, [OTHER, SOON])).toEqual([OTHER, SOON]);
  });
});
