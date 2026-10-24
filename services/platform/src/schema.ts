// Money is stored in minor currency units (BIGINT: kobo, cents, ...); read it back with ::float8 (safe to ~9e15).
export const SCHEMA = `
-- Migration from the Nigeria-only names (idempotent; does nothing on a fresh database).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='members' AND column_name='nin_hash') THEN
    ALTER TABLE members RENAME COLUMN nin_hash TO id_hash;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='finance_ledger' AND column_name='amount_kobo') THEN
    ALTER TABLE finance_ledger RENAME COLUMN amount_kobo TO amount_minor;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quarantine' AND column_name='amount_kobo') THEN
    ALTER TABLE quarantine RENAME COLUMN amount_kobo TO amount_minor;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS member_keys (
  member_id TEXT PRIMARY KEY,
  wrapped_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  id_hash TEXT NOT NULL UNIQUE,           -- one national id, one member (keyed one-way hash)
  phone_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('provisional','active','suspended','resigned','erased')),
  card_no TEXT UNIQUE,
  pin_hash TEXT,
  pin_failures INT NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'anonymous' CHECK (visibility IN ('visible','anonymous')),
  record_enc TEXT,                         -- AES-GCM under the member's own key
  ward TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  activated_by TEXT,
  CHECK (state <> 'active' OR card_no IS NOT NULL)   -- no active member without a card
);
CREATE INDEX IF NOT EXISTS members_phone ON members(phone_hash);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('secretary','electoral_committee','treasurer','auditor','tribunal','ward_agent')),
  ward TEXT,
  public_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS seen_signatures (sig TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS access_log (
  id BIGSERIAL PRIMARY KEY, admin_id TEXT, action TEXT NOT NULL, detail TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  proposer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','executed','failed')),
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 'executing' is the claim taken by the one request that runs the action (older databases lack it in the CHECK).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending','executing','executed','failed'));
-- Execution lease: whoever holds claim_token may apply the action; a claim older than the lease can be taken over (admin.ts).
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS claim_token TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS approval_votes (
  approval_id TEXT NOT NULL, admin_id TEXT NOT NULL, PRIMARY KEY (approval_id, admin_id)
);

CREATE TABLE IF NOT EXISTS rules (
  key TEXT NOT NULL, version INT NOT NULL, value TEXT NOT NULL,
  set_by TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (key, version)
);

CREATE TABLE IF NOT EXISTS contests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  primary_type TEXT NOT NULL,             -- allowed values come from the law pack, not the database
  mode TEXT,
  vote_date TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','noticed','open','closed')),
  register_id TEXT,
  notice_at TIMESTAMPTZ,
  notice_receipt TEXT,
  rules_hash TEXT
);
CREATE TABLE IF NOT EXISTS registers (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fingerprint TEXT NOT NULL,
  member_count INT NOT NULL,
  export_json TEXT NOT NULL,
  inec_receipt TEXT
);

CREATE TABLE IF NOT EXISTS register_members (
  register_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (register_id, member_id)
);

-- Active members left off a register because their record was incomplete (only when the admin chose to file the complete ones).
CREATE TABLE IF NOT EXISTS register_exclusions (
  register_id TEXT NOT NULL, member_id TEXT NOT NULL, card_no TEXT NOT NULL, missing TEXT NOT NULL, PRIMARY KEY (register_id, member_id)
);

-- SMS notices about incomplete records (the appeal period): when each member was told, what was missing, and the filing date given.
CREATE TABLE IF NOT EXISTS record_notices (
  id BIGSERIAL PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('incomplete','excluded')),
  sent_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ,
  missing TEXT,
  stage INT,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS record_notices_member ON record_notices(member_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS record_notices_excluded_once ON record_notices(member_id, missing) WHERE kind='excluded';

-- ---- Elections (phase 1: ballot box). Candidates are public by design; ballots are NOT yet secret (see docs/voting.md). ----
CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL,
  office TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  form_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (form_fee_minor >= 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contest_id, office, scope)
);
-- Anyone who registers to compete is a candidate; admins can only stamp. 'pending_payment' until the form fee (if any) is paid.
CREATE TABLE IF NOT EXISTS candidacies (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  fee_minor BIGINT NOT NULL DEFAULT 0,
  fee_ledger_id BIGINT,
  state TEXT NOT NULL CHECK (state IN ('pending_payment','listed','withdrawn')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  listed_at TIMESTAMPTZ,
  UNIQUE (race_id, member_id)
);
CREATE TABLE IF NOT EXISTS candidate_stamps (
  candidacy_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('vetted','flagged')),
  note TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidacy_id, admin_id)
);
-- One current ballot per member per race (re-voting replaces it). candidacy_id NULL = abstain. Phase 1 stores the voter beside the choice.
CREATE TABLE IF NOT EXISTS ballots (
  contest_id TEXT NOT NULL,
  race_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  candidacy_id TEXT,
  revision INT NOT NULL DEFAULT 1,
  channel TEXT NOT NULL CHECK (channel IN ('ussd','agent','web')),
  agent_id TEXT,
  receipt TEXT NOT NULL,
  cast_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (contest_id, race_id, member_id)
);

-- ---- The secret ballot (docs/secret-ballot-recommendation.md). Ciphertext ballots carry NO member id. ----
ALTER TABLE contests ADD COLUMN IF NOT EXISTS jurisdiction TEXT;   -- the country, state or municipality whose electoral committee supplies the guardians
ALTER TABLE admins ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
CREATE TABLE IF NOT EXISTS guardians (
  contest_id TEXT NOT NULL, admin_id TEXT NOT NULL, position INT NOT NULL,
  public_key TEXT, backups TEXT, verified BOOLEAN,
  appointed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contest_id, admin_id), UNIQUE (contest_id, position)
);
CREATE TABLE IF NOT EXISTS election_keys (
  contest_id TEXT PRIMARY KEY, n INT NOT NULL, quorum INT NOT NULL, joint_public_key TEXT NOT NULL,
  manifest TEXT, manifest_hash TEXT, context TEXT, sealed_at TIMESTAMPTZ
);
-- Who has voted (turnout), with no link to any ballot. Only the day is kept.
CREATE TABLE IF NOT EXISTS voted (
  contest_id TEXT NOT NULL, member_id TEXT NOT NULL, revisions INT NOT NULL DEFAULT 1, last_day TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (contest_id, member_id)
);
-- The ballot box: ciphertext, an anonymous nullifier (same person, same nullifier, so a re-vote supersedes), the channel, the unit (agent
-- ballots only) and the day. No member id, no exact time, no serial number.
CREATE TABLE IF NOT EXISTS enc_ballots (
  id TEXT PRIMARY KEY, contest_id TEXT NOT NULL, nullifier TEXT NOT NULL, ballot TEXT NOT NULL, ballot_code TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('ussd','agent','web')), unit TEXT, cast_day TIMESTAMPTZ NOT NULL, superseded BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS enc_ballots_nullifier ON enc_ballots(contest_id, nullifier);
CREATE INDEX IF NOT EXISTS enc_ballots_code ON enc_ballots(contest_id, ballot_code);
-- Anonymous membership proofs (Semaphore). A member's identity commitment (device = made on their own device; assisted = derived by the
-- platform for USSD and terminal voters), and each contest's fixed group of commitments.
CREATE TABLE IF NOT EXISTS identity_commitments (
  member_id TEXT PRIMARY KEY, commitment TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK (mode IN ('device','assisted')), registered_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS semaphore_groups (
  contest_id TEXT PRIMARY KEY, depth INT NOT NULL, root TEXT NOT NULL, size INT NOT NULL, commitments TEXT NOT NULL, built_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE enc_ballots ADD COLUMN IF NOT EXISTS proof TEXT;   -- the ballot's membership proof: public, anyone can verify it
CREATE TABLE IF NOT EXISTS election_tallies (
  contest_id TEXT NOT NULL, tally_set TEXT NOT NULL, tally TEXT NOT NULL, ballots INT NOT NULL, prepared_at TIMESTAMPTZ NOT NULL,
  counts TEXT, plaintext_tally TEXT, opened_at TIMESTAMPTZ, guardians_present TEXT,
  PRIMARY KEY (contest_id, tally_set)
);
CREATE TABLE IF NOT EXISTS guardian_shares (
  contest_id TEXT NOT NULL, tally_set TEXT NOT NULL, admin_id TEXT NOT NULL, payload TEXT NOT NULL, at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (contest_id, tally_set, admin_id)
);
-- Paper copies kept at polling units, counted after the close and compared with the electronic count.
CREATE TABLE IF NOT EXISTS paper_totals (
  contest_id TEXT NOT NULL, unit TEXT NOT NULL, ballots INT NOT NULL, agent_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (contest_id, unit)
);
CREATE TABLE IF NOT EXISTS paper_counts (
  contest_id TEXT NOT NULL, unit TEXT NOT NULL, race_id TEXT NOT NULL, candidacy_id TEXT NOT NULL, n INT NOT NULL,
  PRIMARY KEY (contest_id, unit, race_id, candidacy_id)
);

CREATE TABLE IF NOT EXISTS finance_ledger (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dues','gift','form')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  member_id TEXT,
  donor_key TEXT,                -- HMAC of donor identity, for cap tracking
  donor_enc TEXT,                -- donor name/address/occupation, encrypted
  contest_id TEXT,
  external_ref TEXT UNIQUE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurred_at TIMESTAMPTZ         -- the deployment clock when recorded (virtual in tests); used for rolling-window caps
);
ALTER TABLE finance_ledger ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
-- Candidate form fees are a third kind of ledger row. Older databases have the two-value check: replace it once.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_ledger_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%form%') THEN
    ALTER TABLE finance_ledger DROP CONSTRAINT finance_ledger_kind_check;
    ALTER TABLE finance_ledger ADD CONSTRAINT finance_ledger_kind_check CHECK (kind IN ('dues','gift','form'));
  END IF;
END $$;
-- One row per attempt to collect money, written BEFORE the provider is called. 'charging' = outcome unknown,
-- 'charged' = provider confirmed but the ledger has no row yet, 'refund_due' = money taken and refused by a rule.
CREATE TABLE IF NOT EXISTS payment_attempts (
  key TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  state TEXT NOT NULL CHECK (state IN ('charging','charged','recorded','refund_due')),
  ref TEXT, currency TEXT, country TEXT,
  ledger_id BIGINT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dues';
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS purpose_id TEXT;   -- what the money is for (a candidacy id for form fees)
-- Transactional outbox for the public log. An event is written in the SAME transaction as the change it describes, then
-- published to the log in order. 'oid' is the idempotency key the log uses to ignore a repeated publish.
CREATE TABLE IF NOT EXISTS log_outbox (
  seq BIGSERIAL PRIMARY KEY,
  oid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS log_outbox_unpublished ON log_outbox(seq) WHERE published_at IS NULL;
-- Join confirmation state shared by every platform instance. The payload (an ID-check result with personal data) is
-- sealed under a one-off data key wrapped by the master key; the row lives for minutes.
CREATE TABLE IF NOT EXISTS pending_joins (
  phone_hash TEXT PRIMARY KEY,
  enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
-- Every PIN guess is recorded BEFORE it is compared and only its own row is removed on success, so a successful login can never
-- erase earlier failures. LOGGED (crash-durable) on purpose: this is the control that limits PIN guessing.
CREATE TABLE IF NOT EXISTS pin_attempts (
  id BIGSERIAL PRIMARY KEY,
  member_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS pin_attempts_member ON pin_attempts(member_id, at);
-- One-time move of the old per-member counter into attempt rows (the old counter is zeroed in the same statement, so this never repeats).
WITH m AS (SELECT id, pin_failures AS n FROM members WHERE pin_failures > 0),
     ins AS (INSERT INTO pin_attempts(member_id, at) SELECT m.id, now() FROM m, generate_series(1, m.n))
UPDATE members SET pin_failures = 0 WHERE id IN (SELECT id FROM m);
-- Crash-durable counters for security-critical limits (failed gateway authentication). See ratelimit.ts for the split.
CREATE TABLE IF NOT EXISTS rate_limits_durable (
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  n INT NOT NULL,
  PRIMARY KEY (key, window_start)
);
-- Volume counters, shared by every platform instance. UNLOGGED: no write-ahead cost, and losing it in a database crash
-- only resets ordinary traffic budgets (never a guess limit). Old windows are deleted as new ones are written.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  n INT NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE TABLE IF NOT EXISTS quarantine (
  id BIGSERIAL PRIMARY KEY, reason TEXT NOT NULL, amount_minor BIGINT, external_ref TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, author_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  threshold INT NOT NULL CHECK (threshold > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_consideration','decided')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signatures (
  proposal_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (proposal_id, member_id)
);
CREATE TABLE IF NOT EXISTS agenda (
  id BIGSERIAL PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  respond_by TIMESTAMPTZ NOT NULL
);

ALTER TABLE contests DROP CONSTRAINT IF EXISTS contests_primary_type_check;
ALTER TABLE contests DROP CONSTRAINT IF EXISTS contests_mode_check;

-- Which configuration (floor + law pack + party settings) this deployment has run. Append-only.
CREATE TABLE IF NOT EXISTS deployment_config (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  floor_version TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, party TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only: the ledger and rule history can never be edited or deleted in place.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table: % is immutable', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_immutable ON finance_ledger;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON finance_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS rules_immutable ON rules;
CREATE TRIGGER rules_immutable BEFORE UPDATE OR DELETE ON rules
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS deployment_immutable ON deployment_config;
CREATE TRIGGER deployment_immutable BEFORE UPDATE OR DELETE ON deployment_config
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS access_immutable ON access_log;
CREATE TRIGGER access_immutable BEFORE UPDATE OR DELETE ON access_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
`;
