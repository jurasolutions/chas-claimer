/**
 * Who is using the desk (`GET /api/me`). `App` loads it once and only renders a page after it
 * arrives, so a page reads it with `useMe()` and never waits for it.
 */
import { createContext, useContext } from "react";
import type { MeResponse } from "../api/common";

export const MeContext = createContext<MeResponse | null>(null);

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe() is only available inside <App>, after /api/me has answered.");
  return me;
}
