// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork } from "../../../tests/helpers/network";
import { MaskedIdentifier } from "./MaskedIdentifier";

const revealUrl = `${window.location.origin}/api/claims/c1/reveal`;

describe("MaskedIdentifier", () => {
  it("stays masked and asks nothing of the server until Show is pressed", () => {
    const fetchStub = stubNetwork({ [revealUrl]: jsonAnswer({ value: "T9000000J" }) });
    render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

    expect(screen.getByText("T****000J")).toBeTruthy();
    expect(screen.queryByText("T9000000J")).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reveals through the audited route once, and says the reveal is recorded", async () => {
    const bodies: unknown[] = [];
    const fetchStub = stubNetwork({
      [revealUrl]: async (request) => {
        bodies.push(await request.json());
        return jsonAnswer({ value: "T9000000J" })(request);
      },
    });
    render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

    fireEvent.click(screen.getByRole("button", { name: "Show NRIC/FIN" }));

    expect(await screen.findByText("T9000000J")).toBeTruthy();
    expect(screen.getByText("Shown and recorded in the claim's history.")).toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(bodies).toEqual([{ field: "nric" }]);
  });

  it("hides the value again without asking a second time", async () => {
    const fetchStub = stubNetwork({ [revealUrl]: jsonAnswer({ value: "T9000000J" }) });
    render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

    fireEvent.click(screen.getByRole("button", { name: "Show NRIC/FIN" }));
    await screen.findByText("T9000000J");
    fireEvent.click(screen.getByRole("button", { name: "Hide NRIC/FIN" }));

    expect(screen.getByText("T****000J")).toBeTruthy();
    expect(screen.queryByText("T9000000J")).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("keeps the value masked and says so when the reveal is refused", async () => {
    stubNetwork({ [revealUrl]: jsonAnswer({ error: "forbidden" }, 403) });
    render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

    fireEvent.click(screen.getByRole("button", { name: "Show NRIC/FIN" }));

    expect(await screen.findByText("You don't have access to reveal this.")).toBeTruthy();
    expect(screen.getByText("T****000J")).toBeTruthy();
  });

  describe("focus after Show (QA N1)", () => {
    it("moves focus to the identifier and its note once the reveal settles", async () => {
      stubNetwork({ [revealUrl]: jsonAnswer({ value: "T9000000J" }) });
      render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

      const show = screen.getByRole("button", { name: "Show NRIC/FIN" });
      show.focus();
      fireEvent.click(show);
      await screen.findByText("T9000000J");

      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.textContent).toContain("T9000000J");
      expect(document.activeElement?.textContent).toContain("Shown and recorded in the claim's history.");
    });

    it("moves focus to the refusal when the reveal is refused", async () => {
      stubNetwork({ [revealUrl]: jsonAnswer({ error: "forbidden" }, 403) });
      render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

      fireEvent.click(screen.getByRole("button", { name: "Show NRIC/FIN" }));
      await screen.findByText("You don't have access to reveal this.");

      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.textContent).toContain("You don't have access to reveal this.");
    });

    it("leaves focus alone before Show is pressed", () => {
      stubNetwork({});
      render(<MaskedIdentifier claimId="c1" field="nric" label="NRIC/FIN" masked="T****000J" />);

      expect(document.activeElement).toBe(document.body);
    });
  });
});
