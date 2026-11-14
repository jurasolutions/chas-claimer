// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import shipped from "../../../connector/mappings/synthetic-clinic.json";
import { jsonAnswer, stubNetwork } from "../../../tests/helpers/network";
import type { MeResponse } from "../../api/common";
import { parseSourceMapping, type SourceMapping } from "../../domain/source-mapping";
import type { CodeMapEntry } from "../../domain/types";
import { MeContext } from "../me";
import { CodeSuggestion, JustificationDraft, MappingProposal, RejectionExplainer } from "./index";

// The slots' props are final (technical §3, UI): blocks 04 and 06 render them before block 09 fills
// them in. These assignments fail the typecheck if a slot's props drift.
const finalProps: {
  CodeSuggestion: (p: { clinicCode: string; description: string; onAccept(e: CodeMapEntry): void }) => JSX.Element | null;
  RejectionExplainer: (p: { claimId: string }) => JSX.Element | null;
  JustificationDraft: (p: { claimId: string; onUse(text: string): void }) => JSX.Element | null;
  MappingProposal: (p: { onAccept(m: SourceMapping): void }) => JSX.Element | null;
} = { CodeSuggestion, RejectionExplainer, JustificationDraft, MappingProposal };

const reviewer = (aiConfigured: boolean): MeResponse => ({ email: "reviewer@clinic.test", roles: ["officer", "reviewer"], aiConfigured, demoMode: true });

function renderAs(me: MeResponse, slot: ReactNode) {
  return render(<MeContext.Provider value={me}>{slot}</MeContext.Provider>);
}

const AI = (route: string) => `${window.location.origin}/api/ai/${route}`;

/** The JSON body of the stub's nth request. */
async function sentBody(stub: ReturnType<typeof stubNetwork>, call = 0): Promise<unknown> {
  const [input, init] = stub.mock.calls[call] as [RequestInfo | URL, RequestInit | undefined];
  return new Request(input, init).json();
}

describe("AI slots without an Anthropic key (AC-6.1)", () => {
  it.each([
    ["Suggest code", <finalProps.CodeSuggestion clinicCode="D20" description="Scale and polish" onAccept={() => {}} />],
    ["Explain the rejection", <finalProps.RejectionExplainer claimId="c1" />],
    ["Draft a justification", <finalProps.JustificationDraft claimId="c1" onUse={() => {}} />],
    ["Propose a mapping", <finalProps.MappingProposal onAccept={() => {}} />],
  ])("%s says AI isn't set up and asks nothing of the server", (button, slot) => {
    renderAs(reviewer(false), slot);

    fireEvent.click(screen.getByRole("button", { name: button }));

    expect(screen.getByRole("alert").textContent).toContain("AI isn't set up");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never submits the form it sits in", () => {
    const submit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    renderAs(
      reviewer(false),
      <form onSubmit={submit}>
        <CodeSuggestion clinicCode="D20" description="Scale and polish" onAccept={() => {}} />
        <RejectionExplainer claimId="c1" />
        <JustificationDraft claimId="c1" onUse={() => {}} />
        <MappingProposal onAccept={() => {}} />
      </form>,
    );

    for (const button of screen.getAllByRole("button")) fireEvent.click(button);

    expect(submit).not.toHaveBeenCalled();
  });
});

describe("CodeSuggestion (SC6.2, AC-6.3)", () => {
  it("asks about the clinic code and accepts the answer as an ai_accepted entry", async () => {
    const stub = stubNetwork({
      [AI("code-suggestion")]: jsonAnswer({ suggestion: { target: "chas", payerId: "", targetCode: "D20", reason: "A scale and polish is a CHAS preventive item." } }),
    });
    const onAccept = vi.fn();
    renderAs(reviewer(true), <CodeSuggestion clinicCode="X-SCALE" description={"Scale and polish ".repeat(40)} onAccept={onAccept} />);

    fireEvent.click(screen.getByRole("button", { name: "Suggest code" }));
    const result = await screen.findByRole("group");

    expect(result.textContent).toContain("Suggested by AI");
    expect(result.textContent).toContain("CHAS procedure D20");
    expect(result.textContent).toContain("A scale and polish is a CHAS preventive item.");
    const sent = (await sentBody(stub)) as { clinicCode: string; description: string };
    expect(sent.clinicCode).toBe("X-SCALE");
    expect(sent.description).toHaveLength(500);
    expect(onAccept).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));

    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ clinicCode: "X-SCALE", target: "chas", payerId: "", targetCode: "D20", origin: "ai_accepted", updatedBy: "reviewer@clinic.test" }),
    );
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("says a code is not claimable when AI finds no CHAS procedure, and dismissing changes nothing", async () => {
    stubNetwork({ [AI("code-suggestion")]: jsonAnswer({ suggestion: { target: "chas", payerId: "", targetCode: null, reason: "Whitening is cosmetic." } }) });
    const onAccept = vi.fn();
    renderAs(reviewer(true), <CodeSuggestion clinicCode="X-WHITE" description="Whitening" onAccept={onAccept} />);

    fireEvent.click(screen.getByRole("button", { name: "Suggest code" }));

    expect((await screen.findByRole("group")).textContent).toContain("Not claimable under CHAS");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(onAccept).not.toHaveBeenCalled();
  });
});

describe("RejectionExplainer (SC6.3)", () => {
  it("shows the explanation and what might fix it", async () => {
    const stub = stubNetwork({
      [AI("rejection-explainer")]: jsonAnswer({ suggestion: { explanation: "The card had expired on the visit date.", fix: "Check the card and resubmit." } }),
    });
    renderAs(reviewer(true), <RejectionExplainer claimId="c1" />);

    fireEvent.click(screen.getByRole("button", { name: "Explain the rejection" }));
    const result = await screen.findByRole("group");

    expect(result.textContent).toContain("The card had expired on the visit date.");
    expect(result.textContent).toContain("What might fix it: Check the card and resubmit.");
    expect(await sentBody(stub)).toEqual({ claimId: "c1" });
  });
});

describe("JustificationDraft (SC6.4)", () => {
  it("hands the draft over only when the person uses it", async () => {
    const stub = stubNetwork({ [AI("justification")]: jsonAnswer({ draft: "Deep caries on 36 needed a root canal." }) });
    const onUse = vi.fn();
    renderAs(reviewer(true), <JustificationDraft claimId="c1" onUse={onUse} />);

    fireEvent.click(screen.getByRole("button", { name: "Draft a justification" }));

    expect((await screen.findByRole("group")).textContent).toContain("Deep caries on 36 needed a root canal.");
    expect(await sentBody(stub)).toEqual({ claimId: "c1" });
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use this draft" }));
    expect(onUse).toHaveBeenCalledWith("Deep caries on 36 needed a root canal.");
  });
});

describe("MappingProposal (SC6.5)", () => {
  const DESCRIBE = ["A sqlite source with 2 tables:", "  visits: visit_id, patient_id", "  patients: patient_id, full_name"].join("\n");

  it("sends only the pasted table and column names and accepts the proposal", async () => {
    // Imported as JSON: connector/test-support reads it from disk, which jsdom's URL can't address.
    const parsed = parseSourceMapping(shipped);
    if (!parsed.ok) throw new Error("the shipped mapping is invalid");
    const mapping = parsed.value;
    const stub = stubNetwork({ [AI("source-mapping")]: jsonAnswer({ suggestion: { mapping, notes: "Amounts look like cents." } }) });
    const onAccept = vi.fn();
    renderAs(reviewer(true), <MappingProposal onAccept={onAccept} />);

    fireEvent.click(screen.getByRole("button", { name: "Propose a mapping" }));
    fireEvent.change(screen.getByLabelText("What the connector printed"), { target: { value: DESCRIBE } });
    fireEvent.click(screen.getByRole("button", { name: "Ask for a proposal" }));
    const result = await screen.findByRole("group");

    expect(await sentBody(stub)).toEqual({
      schema: {
        kind: "sqlite",
        tables: [
          { name: "visits", columns: ["visit_id", "patient_id"] },
          { name: "patients", columns: ["patient_id", "full_name"] },
        ],
      },
    });
    expect(result.textContent).toContain(`Visits: ${mapping.visits.table}`);
    expect(result.textContent).toContain("Amounts look like cents.");
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept mapping" }));
    expect(onAccept).toHaveBeenCalledWith(mapping);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("refuses text that isn't the describe output without asking AI", () => {
    renderAs(reviewer(true), <MappingProposal onAccept={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Propose a mapping" }));
    fireEvent.change(screen.getByLabelText("What the connector printed"), { target: { value: "visit_id,patient_id\nV1,P1" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask for a proposal" }));

    expect(screen.getByText(/isn't what the describe command prints/)).toBeTruthy();
    expect(screen.getByLabelText("What the connector printed").getAttribute("aria-invalid")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("focus after the suggestion closes", () => {
  it.each([
    ["Accept suggestion", "Suggest code"],
    ["Dismiss", "Suggest code"],
  ])("%s hands focus back to %s", async (action, trigger) => {
    stubNetwork({ [AI("code-suggestion")]: jsonAnswer({ suggestion: { target: "chas", payerId: "", targetCode: "D20", reason: "Preventive." } }) });
    renderAs(reviewer(true), <CodeSuggestion clinicCode="X-SCALE" description="Scale and polish" onAccept={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Suggest code" }));
    await screen.findByRole("group");
    fireEvent.click(screen.getByRole("button", { name: action }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: trigger }));
  });

  it("Use this draft hands focus back to its button", async () => {
    stubNetwork({ [AI("justification")]: jsonAnswer({ draft: "Deep caries." }) });
    renderAs(reviewer(true), <JustificationDraft claimId="c1" onUse={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Draft a justification" }));
    await screen.findByRole("group");
    fireEvent.click(screen.getByRole("button", { name: "Use this draft" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Draft a justification" }));
  });

  it("an unreadable paste puts focus on the field to fix", () => {
    renderAs(reviewer(true), <MappingProposal onAccept={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Propose a mapping" }));
    fireEvent.change(screen.getByLabelText("What the connector printed"), { target: { value: "not it" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask for a proposal" }));

    expect(document.activeElement).toBe(screen.getByLabelText("What the connector printed"));
  });

  it("cancelling the paste hands focus back to its button", () => {
    renderAs(reviewer(true), <MappingProposal onAccept={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Propose a mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Propose a mapping" }));
  });
});

describe("AI failures (SC6.7)", () => {
  it.each([
    ["ai_busy", 503, "AI is busy"],
    ["ai_cap_reached", 429, "Today's AI limit is reached"],
    ["ai_unavailable", 502, "AI couldn't answer just now"],
    ["ai_unusable", 502, "AI's answer couldn't be used"],
    ["ai_identifiers_remain", 422, "That wasn't sent to AI"],
    ["ai_not_configured", 503, "AI isn't set up"],
    ["forbidden", 403, "You don't have access to do that."],
    ["internal", 500, "That didn't go through. Try again."],
  ])("%s gives a plain message and changes nothing", async (code, status, words) => {
    stubNetwork({ [AI("justification")]: jsonAnswer({ error: code }, status) });
    const onUse = vi.fn();
    renderAs(reviewer(true), <JustificationDraft claimId="c1" onUse={onUse} />);

    fireEvent.click(screen.getByRole("button", { name: "Draft a justification" }));

    expect((await screen.findByRole("alert")).textContent).toContain(words);
    expect(screen.queryByRole("group")).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
  });

  it("says why it can't explain a claim that is no longer rejected", async () => {
    stubNetwork({ [AI("rejection-explainer")]: jsonAnswer({ error: "not_allowed" }, 409) });
    renderAs(reviewer(true), <RejectionExplainer claimId="c1" />);

    fireEvent.click(screen.getByRole("button", { name: "Explain the rejection" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This claim isn't rejected any more");
    expect(alert.textContent).toContain("Only a rejected claim can be explained.");
  });

  it("asks the person to check their connection when the request never arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    renderAs(reviewer(true), <RejectionExplainer claimId="c1" />);

    fireEvent.click(screen.getByRole("button", { name: "Explain the rejection" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Check your connection");
  });
});

describe("hostile model output (SC6.6)", () => {
  it("shows markup in the answer as text, never as elements", async () => {
    const hostile = '<script>alert(1)</script><b>bold</b><img src=x onerror="alert(2)">';
    stubNetwork({ [AI("rejection-explainer")]: jsonAnswer({ suggestion: { explanation: hostile, fix: hostile } }) });
    renderAs(reviewer(true), <RejectionExplainer claimId="c1" />);

    fireEvent.click(screen.getByRole("button", { name: "Explain the rejection" }));
    const result = await screen.findByRole("group");

    expect(result.textContent).toContain(hostile);
    expect(result.querySelector("script, b, img")).toBeNull();
  });
});
