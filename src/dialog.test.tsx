// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Button, Dialog, Textarea } from "./ds";

/** A page with one button that opens a dialog holding a reason field and two actions. */
function Page({ autoFocusConfirm = false }: { autoFocusConfirm?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">Before</button>
      <Button onClick={() => setOpen(true)}>Withdraw</Button>
      <Dialog
        open={open}
        title="Withdraw this claim"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" autoFocus={autoFocusConfirm} onClick={() => setOpen(false)}>
              Confirm
            </Button>
          </>
        }
      >
        <Textarea aria-label="Reason" />
      </Dialog>
    </>
  );
}

function openDialog(props: { autoFocusConfirm?: boolean } = {}) {
  render(<Page {...props} />);
  const trigger = screen.getByRole("button", { name: "Withdraw" });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Withdraw this claim" }) };
}

describe("Dialog (QA D06)", () => {
  it("moves focus to the first field inside when it opens", () => {
    openDialog();
    expect(document.activeElement).toBe(screen.getByLabelText("Reason"));
  });

  it("leaves focus where a field inside asked for it", () => {
    openDialog({ autoFocusConfirm: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm" }));
  });

  it("keeps Tab inside: forward from the last control wraps to the first, and back from the first to the last", () => {
    const { dialog } = openDialog();
    const close = screen.getByRole("button", { name: "Close" });
    const confirm = screen.getByRole("button", { name: "Confirm" });

    confirm.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("returns focus to the button that opened it when it closes", () => {
    const { trigger } = openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the opener after Escape too", () => {
    const { trigger } = openDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
