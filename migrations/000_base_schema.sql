-- ============================================================================
-- 000_base_schema.sql — Foundation: pgcrypto + users table
-- Must run BEFORE 001_initial_schema.sql (which references user_id UUID)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Minimal users table: only the columns that foreign-key-free columns in
-- 001 reference (accounts.user_id, idempotency_keys.user_id, etc.).
-- Role 2 (identity) will ALTER TABLE users ADD COLUMN ... for phone,
-- name, password_hash, mpin_hash, failed_mpin_attempts, etc.
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
