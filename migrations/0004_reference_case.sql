-- A portal reference is the same reference whatever its case (QA 02 N5).
--
-- Payer portals print references in upper case, but an officer may type one in
-- lower case or with a stray space. The desk keeps what was typed, and compares
-- references on upper(trim(...)), so "mhcp-0001" cannot name a second claim at a
-- payer that already holds "MHCP-0001". The trigger replaces the one in 0001;
-- the rule is otherwise unchanged.

DROP TRIGGER submissions_reference_once;

CREATE TRIGGER submissions_reference_once
BEFORE INSERT ON submissions
WHEN NEW.portal_reference IS NOT NULL AND EXISTS (
  SELECT 1 FROM submissions s JOIN claims c ON c.id = s.claim_id
   WHERE upper(trim(s.portal_reference)) = upper(trim(NEW.portal_reference))
     AND s.claim_id <> NEW.claim_id
     AND c.payer_id = (SELECT payer_id FROM claims WHERE id = NEW.claim_id)
)
BEGIN
  SELECT RAISE(ABORT, 'portal_reference_taken');
END;

-- The trigger and the remittance matcher look references up by this key. Not
-- partial: SQLite skips a partial index for an expression lookup.
CREATE INDEX submissions_portal_reference_key ON submissions(upper(trim(portal_reference)));
CREATE INDEX claims_portal_reference_key ON claims(payer_id, upper(trim(portal_reference)));
