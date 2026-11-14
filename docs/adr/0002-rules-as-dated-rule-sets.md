# Scheme rules are dated data, not code

CHAS subsidy amounts changed on 1 Oct 2025, the benchmark justification rule started on 1 Sep 2026, and the TOSP is updated during 2026. We keep every amount, limit, window and ranking in a versioned rule set carrying its source URL and effective date, and pick the rule set by visit date. Check logic is code; the numbers it checks against are data. This keeps the numbers rule (never publish a figure we can't evidence) auditable: every figure points at the page it came from, and a blank means "not yet confirmed", never a guess.
