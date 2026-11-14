/**
 * The caps on what a claim write takes. Kept apart from the parsers in `claim-actions.ts` so the
 * page can size its fields to match without bundling the validation library.
 */

/** The longest reason, payer message or note an action takes. */
export const MAX_ACTION_TEXT = 2000;
/** The longest portal reference a payer gives. */
export const MAX_PORTAL_REFERENCE = 80;
/** The most claims one batch approval takes (functional spec, batch approval). */
export const MAX_BATCH_ITEMS = 50;
