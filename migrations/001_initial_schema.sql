-- ============================================================================
-- MUDHRA_PAY CORE LEDGER SCHEMA (migrations/001_initial_schema.sql)
-- Role 1: Core Ledger, Concurrency, Idempotency & Reconciliation
-- ============================================================================

-- 1. Custom Types / Enums
CREATE TYPE account_status AS ENUM ('ACTIVE', 'FROZEN_MPIN_LOCKED', 'SUSPENDED', 'CLOSED');
CREATE TYPE account_type AS ENUM ('USER_SAVINGS', 'MERCHANT_CURRENT', 'SYSTEM_SETTLEMENT_VAULT', 'PLATFORM_FEE_REVENUE');
CREATE TYPE ledger_direction AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE journal_type AS ENUM ('P2P_TRANSFER', 'QR_MERCHANT_PAY', 'COLLECT_TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'REVERSAL');
CREATE TYPE journal_status AS ENUM ('INITIATED', 'COMPLETED', 'FAILED', 'REVERSED');
CREATE TYPE idempotency_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- 2. Shared Utility Trigger: Auto-Update updated_at Column
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Idempotency Keys (Network Retry & Replay State Machine)
CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 of method + path + canonical body
    status idempotency_status NOT NULL DEFAULT 'IN_PROGRESS',
    status_code INT,
    response_payload JSONB,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, key)
);

-- 4. Accounts (The Graph Nodes)
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type account_type NOT NULL DEFAULT 'USER_SAVINGS',
    cached_balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (cached_balance_paise >= 0),
    status account_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_accounts_touch_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 5. Journal Transactions (The Financial Events)
CREATE TABLE journal_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key_id UUID UNIQUE REFERENCES idempotency_keys(id),
    type journal_type NOT NULL,
    status journal_status NOT NULL DEFAULT 'INITIATED',
    reversal_of_id UUID UNIQUE REFERENCES journal_transactions(id),
    created_by_user_id UUID NOT NULL,
    reference_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Ledger Entries (The Immutable Directed Edges)
-- Note: running_balance_paise MUST be computed atomically in executeJournalTransfer() while holding FOR UPDATE lock
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_id UUID NOT NULL REFERENCES journal_transactions(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    direction ledger_direction NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    running_balance_paise BIGINT NOT NULL CHECK (running_balance_paise >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Reconciliation Exceptions (Drift Detection Audit Table)
CREATE TABLE reconciliation_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    expected_balance_paise BIGINT NOT NULL, -- Live SUM(ledger_entries)
    actual_balance_paise BIGINT NOT NULL,   -- accounts.cached_balance_paise
    drift_paise BIGINT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ,
    resolved_by_user_id UUID
);

-- ============================================================================
-- INDEXES FOR HIGH-SPEED QUERIES, PAGINATION & BACKGROUND WORKERS
-- ============================================================================
CREATE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE INDEX idx_accounts_non_active ON accounts(id) WHERE status <> 'ACTIVE';
CREATE INDEX idx_journals_status ON journal_transactions(status) WHERE status <> 'COMPLETED';
CREATE INDEX idx_ledger_entries_journal_id ON ledger_entries(journal_id);
CREATE INDEX idx_ledger_entries_account_statement ON ledger_entries(account_id, created_at DESC, id DESC);
CREATE INDEX idx_idempotency_stale_inprogress ON idempotency_keys(locked_at) WHERE status = 'IN_PROGRESS';
CREATE INDEX idx_reconciliation_unresolved ON reconciliation_exceptions(account_id) WHERE resolved_at IS NULL;

-- ============================================================================
-- SAFETY NET 1: STRICT APPEND-ONLY IMMUTABILITY ON LEDGER ENTRIES
-- ============================================================================
CREATE OR REPLACE FUNCTION block_ledger_modifications()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CRITICAL: Ledger immutability violation. Cannot % on ledger_entries.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_immutability_row
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION block_ledger_modifications();

CREATE TRIGGER trg_ledger_immutability_truncate
BEFORE TRUNCATE ON ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION block_ledger_modifications();

-- ============================================================================
-- SAFETY NET 2: JOURNAL INTEGRITY PROTECTION (WITH IS DISTINCT FROM)
-- ============================================================================
CREATE OR REPLACE FUNCTION protect_journal_integrity()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CRITICAL: Cannot DELETE a journal_transaction.';
    END IF;

    IF NEW.id <> OLD.id 
       OR NEW.type <> OLD.type 
       OR NEW.created_by_user_id <> OLD.created_by_user_id 
       OR NEW.created_at <> OLD.created_at
       OR NEW.idempotency_key_id IS DISTINCT FROM OLD.idempotency_key_id
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id THEN
        RAISE EXCEPTION 'CRITICAL: Cannot alter immutable journal fields. Only status updates are permitted.';
    END IF;

    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_journal_integrity
BEFORE UPDATE OR DELETE ON journal_transactions
FOR EACH ROW EXECUTE FUNCTION protect_journal_integrity();

-- ============================================================================
-- SAFETY NET 3: IDEMPOTENCY REPLAY INTEGRITY & 30-DAY RETENTION GUARD
-- ============================================================================
CREATE OR REPLACE FUNCTION protect_idempotency_integrity()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'IN_PROGRESS' OR OLD.created_at > (CURRENT_TIMESTAMP - INTERVAL '30 days') THEN
            RAISE EXCEPTION 'CRITICAL: Cannot DELETE an active or recent (<30 days) idempotency_keys row.';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.key <> OLD.key OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'CRITICAL: Cannot alter immutable idempotency identity fields.';
    END IF;

    IF OLD.status IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'CRITICAL: Cannot modify a finalized (%) idempotency key.', OLD.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_idempotency
BEFORE UPDATE OR DELETE ON idempotency_keys
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_integrity();

-- ============================================================================
-- SAFETY NET 4: DEFERRED ZERO-SUM DOUBLE-ENTRY ENFORCEMENT (AT COMMIT TIME)
-- ============================================================================
CREATE OR REPLACE FUNCTION check_journal_zero_sum()
RETURNS TRIGGER AS $$
DECLARE
    net_balance BIGINT;
    entry_count INT;
BEGIN
    SELECT 
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_paise ELSE -amount_paise END), 0),
        COUNT(*)
    INTO net_balance, entry_count
    FROM ledger_entries
    WHERE journal_id = NEW.journal_id;

    IF entry_count < 2 THEN
        RAISE EXCEPTION 'CRITICAL: Double-entry violation on journal %. Minimum 2 ledger entries required (found %).', NEW.journal_id, entry_count;
    END IF;

    IF net_balance <> 0 THEN
        RAISE EXCEPTION 'CRITICAL: Zero-sum violation on journal %. Credits minus Debits must equal 0 (found %).', NEW.journal_id, net_balance;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_enforce_zero_sum
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_journal_zero_sum();