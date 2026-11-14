/**
 * How a claim service's refusal (`ActError`) answers over HTTP. The body carries a code and the
 * structured detail the page needs (the version to reload, who has the checklist open). The only
 * request value it repeats is a portal reference already on another claim, so the page can name it;
 * reasons, messages and notes never come back. Batch approval reuses the same status and body per
 * failed claim.
 */
import type { ProblemBody } from "../src/api/common";
import { problem } from "./http";
import type { ActError } from "./services/claims";

export function actErrorBody(error: ActError): { status: number; body: ProblemBody } {
  switch (error.code) {
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "stale":
      return { status: 409, body: { error: "stale", currentVersion: error.currentVersion } };
    case "checked_out":
      return { status: 409, body: { error: "checked_out", by: error.by, until: error.until } };
    case "reference_taken":
      return { status: 409, body: { error: "reference_taken", portalReference: error.portalReference } };
    case "not_allowed":
      return { status: 409, body: { error: "not_allowed", detail: error.detail } };
    case "forbidden":
      return { status: 403, body: { error: "forbidden", detail: error.detail } };
    case "invalid":
      return { status: 400, body: { error: "invalid", issues: [{ path: error.field, message: error.problem }] } };
  }
}

export function actProblem(error: ActError): Response {
  const { status, body } = actErrorBody(error);
  const { error: code, ...detail } = body;
  return problem(status, code, detail);
}
