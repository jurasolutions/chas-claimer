/**
 * The optimistic retry the desk's writers share: read, plan, write in one batch, and if something
 * moved under the batch, read again and try again, a bounded number of times.
 */

/** How many times a writer tries before giving up. */
export const MAX_ATTEMPTS = 3;

/** What an attempt answers when it lost a race and should run again from fresh reads. */
export const RETRY: unique symbol = Symbol("retry");

/**
 * Runs `attempt` until it answers something other than `RETRY`, at most `MAX_ATTEMPTS` times, then
 * throws `exhausted()`. An error the attempt throws itself passes straight through.
 */
export async function withRetry<T>(attempt: () => Promise<T | typeof RETRY>, exhausted: () => Error): Promise<T> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await attempt();
    if (result !== RETRY) return result as T;
  }
  throw exhausted();
}
