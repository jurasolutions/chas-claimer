import { useEffect, useRef } from "react";

/**
 * Where focus goes once an action settles (QA N1). An action often replaces the button that ran it,
 * and focus would fall to the body, so the next Tab starts again from the top of the page. Put the
 * returned ref on whatever says what happened, a status line or a heading, give it `tabIndex={-1}`
 * and the `settled-focus` class (see `src/ui/app.css`), and focus moves there each time `settled`
 * changes to a new truthy value.
 *
 * Pass a counter that goes up after each action, so a first load leaves focus alone, `true` for an
 * element that only appears once the action is done, or a new object each time, such as the
 * action's result. Any new truthy value moves focus; the same object again does not.
 */
export function useFocusOnSettle<T extends HTMLElement>(settled: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (settled) ref.current?.focus();
  }, [settled]);
  return ref;
}
