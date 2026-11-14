-- What the build says about a visit as a whole (QA 01 D02).
--
-- The claim builder explains a visit beside its claims: a line held until the
-- treatment is complete, why a payer has no claim, the Public Assistance balance
-- warning, a withdrawn claim the desk doesn't build again. Each rebuild writes
-- them here for the current revision, so the claim page can show them. Both
-- columns hold JSON arrays of codes and parameters, never an identifier.

ALTER TABLE visits ADD COLUMN notes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE visits ADD COLUMN findings_json TEXT NOT NULL DEFAULT '[]';
