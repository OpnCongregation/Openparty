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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executed','failed')),
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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

CREATE TABLE IF NOT EXISTS finance_ledger (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dues','gift')),
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
