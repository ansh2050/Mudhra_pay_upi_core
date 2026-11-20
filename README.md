# Mudhra_Pay Core — Double-Entry Banking & UPI Switch Backend

A high-integrity financial backend replicating the core mechanics of an Indian UPI TPAP/Switch and Core Banking Ledger.

## Architecture Pillars
- **`src/modules/ledger-core`**: Append-only double-entry bookkeeping, pessimistic row locking (`SELECT ... FOR UPDATE`), idempotency middleware, and automated reconciliation.
- **`src/modules/identity`**: User authentication, JWT session rotation, 2FA UPI MPIN verification, account lifecycle, and security audit logs.
- **`src/modules/upi-switch`**: VPA (`@mudhra_pay`) directory resolution, HMAC-signed dynamic QR codes, P2P & Collect payment intents, and account statements.
