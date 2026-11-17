-- 003_idempotency_integration.sql
-- Run as ONE batch through your migration runner (it must not split on ';',
-- because of the $$ blocks) and do NOT add BEGIN/COMMIT: the runner's implicit
-- transaction already makes the whole file atomic.
-- Assumes idempotency_keys already exists (from 001) with id UUID, user_id UUID,
-- key, request_hash, status, status_code, response_payload, locked_at.

-- ---------------------------------------------------------------------------
-- 1. Columns the new middleware needs
-- ---------------------------------------------------------------------------
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;
-- 30 days matches your existing "no delete under 30 days" rule. Change if you want shorter.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days';
-- On databases built from 001, the ADD COLUMN IF NOT EXISTS for expires_at is a no-op
-- because the column already exists (with a 48-hour default from 001). This ALTER forces
-- the 30-day default regardless of which migration created the column.
ALTER TABLE idempotency_keys
  ALTER COLUMN expires_at SET DEFAULT now() + interval '30 days';

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- 2. Safety-net constraints, added only if they don't already exist
--    (verify the real names with:  \d journal_transactions )
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'journal_transactions_idempotency_key_id_key'
                    AND conrelid = 'journal_transactions'::regclass) THEN
    ALTER TABLE journal_transactions
      ADD CONSTRAINT journal_transactions_idempotency_key_id_key UNIQUE (idempotency_key_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'journal_transactions_reversal_of_id_key'
                    AND conrelid = 'journal_transactions'::regclass) THEN
    ALTER TABLE journal_transactions
      ADD CONSTRAINT journal_transactions_reversal_of_id_key UNIQUE (reversal_of_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'accounts_balance_non_negative'
                    AND conrelid = 'accounts'::regclass) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_balance_non_negative CHECK (cached_balance_paise >= 0);
  END IF;

  -- Triggers here only fire on UPDATE/DELETE, so enforce this on INSERT too.
  -- If this fails, you have old COMPLETED rows with a NULL status_code: fix them first.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'idempotency_completed_has_status_code'
                    AND conrelid = 'idempotency_keys'::regclass) THEN
    ALTER TABLE idempotency_keys
      ADD CONSTRAINT idempotency_completed_has_status_code
      CHECK (status <> 'COMPLETED' OR status_code IS NOT NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Replacement for protect_idempotency_integrity
--
--  DELETE : never IN_PROGRESS, never before expires_at.
--  UPDATE : identity columns immutable; attempt never decreases;
--           COMPLETED is final; FAILED with a status_code is final;
--           FAILED with status_code NULL ("released") may only go back to
--           IN_PROGRESS with a higher attempt;
--           IN_PROGRESS may stay IN_PROGRESS (stale takeover, attempt+1) or
--           finish; COMPLETED must carry a status_code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_idempotency_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'IN_PROGRESS' THEN
      RAISE EXCEPTION 'Cannot delete IN_PROGRESS idempotency key %', OLD.id;
    END IF;
    IF OLD.expires_at > now() THEN
      RAISE EXCEPTION 'Cannot delete idempotency key % before it expires (%)', OLD.id, OLD.expires_at;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'idempotency_keys identity columns are immutable';
  END IF;

  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'idempotency_keys.attempt cannot decrease';
  END IF;

  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'COMPLETED idempotency key % is final', OLD.id;
  END IF;

  IF OLD.status = 'FAILED' THEN
    IF OLD.status_code IS NOT NULL THEN
      RAISE EXCEPTION 'FAILED idempotency key % with a cached response is final', OLD.id;
    END IF;
    -- released row: only a retry takeover is allowed
    IF NEW.status <> 'IN_PROGRESS' OR NEW.attempt <= OLD.attempt THEN
      RAISE EXCEPTION 'Released idempotency key % can only be re-claimed (IN_PROGRESS, attempt+1)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = IN_PROGRESS
  IF NEW.status = 'COMPLETED' AND NEW.status_code IS NULL THEN
    RAISE EXCEPTION 'COMPLETED idempotency key % must have a status_code', OLD.id;
  END IF;
  RETURN NEW;
END $$;

-- Drop whatever trigger(s) currently use that function (their names are unknown to me), then recreate.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'idempotency_keys'::regclass
       AND NOT tgisinternal
       AND tgfoid = 'protect_idempotency_integrity'::regproc
  LOOP
    EXECUTE format('DROP TRIGGER %I ON idempotency_keys', t.tgname);
  END LOOP;
END $$;

-- OPTIONAL: align pre-existing rows to created_at + 30 days (otherwise they get now() + 30 days
-- from the column default). It must run HERE: after the old trigger is gone and before the new
-- one exists, because the new trigger treats COMPLETED rows as final.
-- UPDATE idempotency_keys SET expires_at = created_at + interval '30 days';

-- EXECUTE FUNCTION needs Postgres 11+ (use EXECUTE PROCEDURE on older versions).
CREATE TRIGGER trg_protect_idempotency_integrity
  BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION protect_idempotency_integrity();
