-- Rotating IDENTIFIER_KEY (infra review I1, ADR 0006).
--
-- A visit revision stays immutable in what it says. The one change allowed is a
-- re-key: the reseal route opens a revision under the previous key and writes the
-- same identity sealed, and the same content hashed, under the current key. The
-- trigger lets an update through only when nothing but identity_sealed and
-- content_hash changes, both carry the same well-formed version prefix ("v<n>:",
-- n from 1 to 999 written plainly, as server/crypto.ts reads it), and that prefix
-- differs from the one the seal had. Everything else still aborts.

DROP TRIGGER visit_revisions_no_update;

CREATE TRIGGER visit_revisions_no_update
BEFORE UPDATE ON visit_revisions
WHEN NOT (
  NEW.visit_key IS OLD.visit_key
  AND NEW.revision IS OLD.revision
  AND NEW.import_id IS OLD.import_id
  AND NEW.clinical_json IS OLD.clinical_json
  AND NEW.created_at IS OLD.created_at
  AND (
    substr(NEW.identity_sealed, 1, instr(NEW.identity_sealed, ':')) GLOB 'v[1-9]:'
    OR substr(NEW.identity_sealed, 1, instr(NEW.identity_sealed, ':')) GLOB 'v[1-9][0-9]:'
    OR substr(NEW.identity_sealed, 1, instr(NEW.identity_sealed, ':')) GLOB 'v[1-9][0-9][0-9]:'
  )
  AND substr(NEW.identity_sealed, 1, instr(NEW.identity_sealed, ':')) = substr(NEW.content_hash, 1, instr(NEW.content_hash, ':'))
  AND substr(NEW.identity_sealed, 1, instr(NEW.identity_sealed, ':')) IS NOT substr(OLD.identity_sealed, 1, instr(OLD.identity_sealed, ':'))
)
BEGIN
  SELECT RAISE(ABORT, 'visit_revisions is immutable: a revision is never changed, only re-keyed');
END;

-- Moving a patient's remittance lines to the current key's hash looks them up by hash.
CREATE INDEX remittance_lines_patient ON remittance_lines (patient_hash);

-- A payment statement's file hash, and a line's patient hash, can't be re-keyed:
-- the desk never holds the file or the payer's NRIC again to hash them under a new
-- key. The key version beside them lets the reseal route count what stays under a
-- retired key, and lets an import spot a file it may have taken in under one.
-- Rows written before this column existed take the version from their prefix; a
-- hash with none stays NULL, which counts as not under the current key.
ALTER TABLE remittances ADD COLUMN key_version INTEGER;
ALTER TABLE remittance_lines ADD COLUMN key_version INTEGER;

UPDATE remittances
SET key_version = CAST(substr(file_hash, 2, instr(file_hash, ':') - 2) AS INTEGER)
WHERE substr(file_hash, 1, instr(file_hash, ':')) GLOB 'v[1-9]:'
  OR substr(file_hash, 1, instr(file_hash, ':')) GLOB 'v[1-9][0-9]:'
  OR substr(file_hash, 1, instr(file_hash, ':')) GLOB 'v[1-9][0-9][0-9]:';

UPDATE remittance_lines
SET key_version = CAST(substr(patient_hash, 2, instr(patient_hash, ':') - 2) AS INTEGER)
WHERE substr(patient_hash, 1, instr(patient_hash, ':')) GLOB 'v[1-9]:'
  OR substr(patient_hash, 1, instr(patient_hash, ':')) GLOB 'v[1-9][0-9]:'
  OR substr(patient_hash, 1, instr(patient_hash, ':')) GLOB 'v[1-9][0-9][0-9]:';
