-- The synthetic clinic's own database: a made-up clinic management system's tables, not the desk's.
-- The connector (ticket 05) reads it through connector/mappings/synthetic-clinic.json. Every row
-- is synthetic. Money is in cents; dates are YYYY-MM-DD text; the enum values (CHAS tier,
-- treatment status, MCAF type, account-holder relationship) are the desk's own spellings.

CREATE TABLE branches (
  branch_code TEXT PRIMARY KEY,
  branch_name TEXT NOT NULL
);

CREATE TABLE doctors (
  doctor_code TEXT PRIMARY KEY,
  doctor_name TEXT NOT NULL
);

CREATE TABLE patients (
  patient_id TEXT PRIMARY KEY,
  nric       TEXT NOT NULL UNIQUE,
  full_name  TEXT NOT NULL,
  mobile     TEXT NOT NULL,
  dob        TEXT NOT NULL,
  address    TEXT
);

-- A patient may hold more than one card (D21). A visit carries every card the patient holds, in
-- card_id order, never only the first or lowest (ticket 05).
CREATE TABLE chas_cards (
  card_id     INTEGER PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients (patient_id),
  tier        TEXT NOT NULL,
  expiry_date TEXT NOT NULL
);

CREATE TABLE insurance_policies (
  policy_id          INTEGER PRIMARY KEY,
  patient_id         TEXT NOT NULL REFERENCES patients (patient_id),
  insurer_code       TEXT NOT NULL,
  member_no          TEXT NOT NULL,
  plan_name          TEXT NOT NULL,
  employer           TEXT,
  annual_limit_cents INTEGER,
  valid_from         TEXT NOT NULL,
  valid_to           TEXT
);

CREATE TABLE appointments (
  appt_id     INTEGER PRIMARY KEY,
  appt_no     TEXT NOT NULL UNIQUE,
  patient_id  TEXT NOT NULL REFERENCES patients (patient_id),
  branch_code TEXT NOT NULL REFERENCES branches (branch_code),
  doctor_code TEXT NOT NULL REFERENCES doctors (doctor_code),
  appt_date   TEXT NOT NULL,
  start_time  TEXT,
  is_void     INTEGER NOT NULL DEFAULT 0,
  doctor_note TEXT
);

CREATE TABLE treatment_lines (
  line_id      INTEGER PRIMARY KEY,
  appt_no      TEXT NOT NULL REFERENCES appointments (appt_no),
  line_no      INTEGER NOT NULL,
  item_code    TEXT NOT NULL,
  item_desc    TEXT NOT NULL,
  fee_cents    INTEGER NOT NULL,
  gst_cents    INTEGER,
  tooth        TEXT,
  qty          INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'complete',
  completed_on TEXT,
  UNIQUE (appt_no, line_no)
);

CREATE TABLE medisave_details (
  appt_no             TEXT PRIMARY KEY REFERENCES appointments (appt_no),
  holder_relationship TEXT NOT NULL,
  holder_nric         TEXT,
  holder_age          INTEGER,
  mcaf_type           TEXT NOT NULL,
  mcaf_valid_from     TEXT NOT NULL,
  mcaf_valid_to       TEXT,
  mcaf_revoked_on     TEXT
);

-- Empty as generated: UAT 5.16 has the tester add PA-0016 to D16. Each row lands on the
-- appointment patient's policy with the same insurer_code; one with no such policy is refused.
CREATE TABLE preauthorisations (
  preauth_id   INTEGER PRIMARY KEY,
  appt_no      TEXT NOT NULL REFERENCES appointments (appt_no),
  insurer_code TEXT NOT NULL,
  benefit_code TEXT NOT NULL,
  preauth_ref  TEXT NOT NULL,
  approved_on  TEXT NOT NULL
);
