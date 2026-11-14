/**
 * The desk's Dialog: the design system's modal, plus the focus handling a modal needs (QA D06).
 * Opening it moves focus inside, Tab stays inside while it's open, and closing it puts focus back
 * on whatever opened it. `src/ds.ts` exports this as `Dialog`, so every screen gets it.
 *
 * It also keeps the dialog inside the viewport (QA N2): the dialog is never taller than the screen,
 * and its body scrolls between the header (with Close) and the footer (with the actions), so the
 * way out and the way forward stay in reach on a short or narrow screen. See `.desk-dialog` in
 * `src/ui/app.css`.
 *
 * The fix belongs upstream in `jurasolutions/design-system/` (its Dialog sets aria-modal but leaves
 * focus behind). Once it lands there and is synced, this wrapper can go.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Dialog as DesignSystemDialog, type DialogProps } from "./design-system/components/feedback/Dialog";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

export function Dialog({ open, id, onKeyDown, className, children, ...rest }: DialogProps) {
  const ownId = useId();
  const dialogId = id ?? ownId;
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // Note who had focus before the dialog renders: a field inside with autoFocus takes it during
  // the same commit, before any effect could look.
  if (open && !wasOpen.current && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const dialog = document.getElementById(dialogId);
    if (dialog && !dialog.contains(document.activeElement)) {
      // The first control past the header's Close button: a form's first field, or its actions.
      const all = focusables(dialog);
      const first = all.find((el) => el.getAttribute("aria-label") !== "Close") ?? all[0];
      (first ?? dialog).focus();
    }
    return () => {
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    };
  }, [open, dialogId]);

  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const all = focusables(event.currentTarget);
    if (all.length === 0) {
      event.preventDefault();
      return;
    }
    const first = all[0]!;
    const last = all[all.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <DesignSystemDialog
      open={open}
      id={dialogId}
      tabIndex={-1}
      onKeyDown={trapTab}
      className={className ? `desk-dialog ${className}` : "desk-dialog"}
      {...rest}
    >
      <div className="desk-dialog__body">{children}</div>
    </DesignSystemDialog>
  );
}
