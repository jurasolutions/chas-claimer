-- The claims desk's schema (technical §5).
--
-- Money is INTEGER cents. Instants are ISO 8601 UTC text. Calendar dates are
-- SGT YYYY-MM-DD text. Booleans are 0 or 1.
--
-- Every status and kind column carries a CHECK whose list matches the `as const`
-- array of the same name in src/domain/types.ts; tests/schema.test.ts keeps the
-- two in step. Two open-ended columns have no CHECK: audit_events.action and
-- findings.code. Both grow as later blocks land, SQLite cannot alter a CHECK
-- without rebuilding the table, and rebuilding the append-only audit log is the
-- one migration this schema should never need. The TypeScript unions guard them.
--
-- No identifier is stored in the clear. Identity is sealed (AES-GCM) in
-- visit_revisions.identity_sealed; patients are found by patient_hash (HMAC)
-- and shown by patient_mask.

-- ------------------------------------------------------------------ imports and visits

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('connector', 'synthetic', 'upload')),
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  received INTEGER NOT NULL DEFAULT 0,
  new INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE visits (
  visit_key TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  patient_hash TEXT NOT NULL,
  patient_mask TEXT NOT NULL
);

CREATE INDEX visits_patient_date ON visits (patient_hash, visit_date);

CREATE TABLE visit_revisions (
  visit_key TEXT NOT NULL REFERENCES visits (visit_key),
  revision INTEGER NOT NULL,
  import_id TEXT NOT NULL REFERENCES imports (id),
  content_hash TEXT NOT NULL,
  clinical_json TEXT NOT NULL,
  identity_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (visit_key, revision)
);

CREATE TRIGGER visit_revisions_no_update
BEFORE UPDATE ON visit_revisions
BEGIN
  SELECT RAISE(ABORT, 'visit_revisions is immutable: a revision is never changed');
END;

CREATE TRIGGER visit_revisions_no_delete
BEFORE DELETE ON visit_revisions
BEGIN
  SELECT RAISE(ABORT, 'visit_revisions is immutable: a revision is never removed');
END;

-- ------------------------------------------------------------------ claims

-- A transition is one guarded UPDATE: version = version + 1 and a fresh
-- last_action nonce, WHERE id = ? AND version = ?. Its audit event is inserted
-- by SELECT ... FROM claims WHERE id = ? AND last_action = ?, so a stale write
-- changes nothing and records nothing (technical F7).
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  visit_key TEXT NOT NULL REFERENCES visits (visit_key),
  payer_id TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('chas', 'medisave_tosp', 'medisave_flexi', 'insurance')),
  branch_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'needs_attention', 'ready', 'approved', 'submitted', 'accepted',
    'rejected', 'paid', 'withdrawn', 'written_off'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  last_action TEXT NOT NULL,
  rule_set_id TEXT NOT NULL,
  built_from_revision INTEGER NOT NULL,
  approved_revision INTEGER,
  submitted_revision INTEGER,
  fee_cents INTEGER NOT NULL,
  claimed_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  accepted_cents INTEGER,
  overpaid INTEGER NOT NULL DEFAULT 0 CHECK (overpaid IN (0, 1)),
  deadline_date TEXT,
  portal_reference TEXT,
  -- Stamped at approval from the payer's settings (S15); null before then.
  channel TEXT CHECK (channel IN ('assisted', 'file', 'api', 'simulator')),
  changed_after_submission INTEGER NOT NULL DEFAULT 0 CHECK (changed_after_submission IN (0, 1)),
  self_approved INTEGER NOT NULL DEFAULT 0 CHECK (self_approved IN (0, 1)),
  approved_by TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  patient_hash TEXT NOT NULL,
  patient_mask TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  annotations_json TEXT NOT NULL DEFAULT '{}',
  -- Who has the claim open on the portal, and until when (30 minutes).
  checkout_by TEXT,
  checkout_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (visit_key, payer_id)
);

CREATE INDEX claims_status_deadline ON claims (status, deadline_date);
CREATE INDEX claims_portal_reference ON claims (portal_reference);
CREATE INDEX claims_patient_date ON claims (patient_hash, visit_date);
CREATE INDEX claims_payer_status ON claims (payer_id, status);

CREATE TABLE claim_lines (
  claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  treatment_ref TEXT NOT NULL,
  scheme_code TEXT,
  tooth TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  fee_cents INTEGER NOT NULL,
  considered_cents INTEGER NOT NULL,
  claimed_cents INTEGER NOT NULL,
  PRIMARY KEY (claim_id, line_no)
);

-- Replaced wholesale on each build.
CREATE TABLE findings (
  claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'warning')),
  params_json TEXT NOT NULL DEFAULT '{}',
  rule_ref TEXT NOT NULL,
  -- The claim line the finding concerns; NULL for a finding on the whole claim.
  line_no INTEGER,
  PRIMARY KEY (claim_id, seq)
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims (id),
  attempt INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('assisted', 'file', 'api', 'simulator')),
  batch_ref TEXT,
  packet_masked_json TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('checklist', 'exported', 'sent', 'failed')),
  portal_reference TEXT,
  error TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (claim_id, attempt)
);

CREATE INDEX submissions_portal_reference ON submissions (portal_reference) WHERE portal_reference IS NOT NULL;

-- A portal reference names one claim at one payer (S6, AC-4.3). The payer sits
-- on claims, so a unique index cannot hold the rule; this trigger does, inside
-- the transition's batch, so two claims sent at once cannot both take one
-- reference. A claim sent again may carry the reference it was first given.
CREATE TRIGGER submissions_reference_once
BEFORE INSERT ON submissions
WHEN NEW.portal_reference IS NOT NULL AND EXISTS (
  SELECT 1 FROM submissions s JOIN claims c ON c.id = s.claim_id
   WHERE s.portal_reference = NEW.portal_reference
     AND s.claim_id <> NEW.claim_id
     AND c.payer_id = (SELECT payer_id FROM claims WHERE id = NEW.claim_id)
)
BEGIN
  SELECT RAISE(ABORT, 'portal_reference_taken');
END;

-- ------------------------------------------------------------------ audit log

-- Append-only, in the landing-page 0003 pattern: triggers refuse UPDATE,
-- DELETE and an insert that would replace an existing row.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('claim', 'visit', 'import', 'settings', 'code_map', 'remittance')),
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: rows are never updated');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: rows are never deleted');
END;

-- INSERT OR REPLACE removes the row it collides with without firing the
-- delete trigger, so an insert that names an id already in use is refused too.
CREATE TRIGGER audit_events_no_replace
BEFORE INSERT ON audit_events
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: an id is never reused');
END;

-- ------------------------------------------------------------------ remittances

-- Remittance files carry NRICs: only the match-key hash is stored.
CREATE TABLE remittances (
  id TEXT PRIMARY KEY,
  payer_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  UNIQUE (payer_id, file_hash)
);

CREATE TABLE remittance_lines (
  remittance_id TEXT NOT NULL REFERENCES remittances (id),
  line_no INTEGER NOT NULL,
  portal_reference TEXT,
  patient_hash TEXT,
  visit_date TEXT,
  amount_cents INTEGER NOT NULL,
  paid_on TEXT,
  claim_id TEXT REFERENCES claims (id),
  match_kind TEXT CHECK (match_kind IN ('reference', 'patient_date_amount', 'manual')),
  PRIMARY KEY (remittance_id, line_no)
);

-- A claim paid in part can be paid again from a later file, but once per file.
CREATE UNIQUE INDEX remittance_lines_claim_once
  ON remittance_lines (remittance_id, claim_id) WHERE claim_id IS NOT NULL;

-- ------------------------------------------------------------------ settings, code map, simulator, AI

-- One document, validated by DeskSettings on every read and write.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- payer_id is '' for chas and tosp targets. A null target_code is an explicit
-- "not claimable" mapping (D20).
CREATE TABLE code_map (
  clinic_code TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('chas', 'tosp', 'benefit')),
  payer_id TEXT NOT NULL DEFAULT '',
  target_code TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'ai_accepted')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (clinic_code, target, payer_id)
);

CREATE TABLE sim_inbox (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims (id),
  payer_id TEXT NOT NULL,
  packet_masked_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received', 'accepted', 'rejected', 'paid')),
  reason TEXT,
  sim_reference TEXT,
  paid_cents INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (claim_id, sim_reference)
);

CREATE TABLE ai_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  cost_nano_usd INTEGER NOT NULL DEFAULT 0
);
