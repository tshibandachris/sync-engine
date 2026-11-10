# Electron device proof and approval lifecycle

The Electron main process owns the device key pair and the complete device authentication lifecycle.

## Initial enrollment

1. The user supplies an agent JWT and a one-time pairing code issued for that agent's tenant.
2. Electron creates a P-256 key pair and a client-generated UUID. The private key, public key and device UUID are first persisted in an OS-encrypted `safeStorage` envelope marked as a pending enrollment. This permits recovery if the HTTP response is lost after the server commits.
3. Electron creates an ES256 compact JWS (`typ=dpop+jwt`) binding:
   - `POST` and `/api/v1/devices/enroll`
   - a fresh UUID `jti` and current `iat`
   - base64url SHA-256 of the normalized activation code
   - the persisted installation fingerprint
   - the client-generated device UUID
4. The API requires the agent JWT, checks the tenant against the one-time pairing code, validates the P-256 key and 64-byte IEEE P1363 signature, and calculates the RFC 7638 thumbprint itself.
5. A single `SECURITY DEFINER` database function consumes the pairing code and creates the pending device, active ES256 credential and immutable `requested` audit event in one transaction. Direct `sync_app` writes to credentials and approval events remain revoked.
6. Electron stores the returned tenant/device identity and `pending_approval` state in `safeStorage`.

The pairing code is single-use and the initial proof is validated before any database write. A client-generated device UUID is included in the signed claims and stored before the request, allowing the client to recover the server result through the status endpoint if the response is lost.

## Approval and synchronization

- `GET /api/v1/devices/status` is authenticated with the agent JWT and scoped to its tenant. It does not require a device proof because it is the bootstrap/status path for a pending terminal.
- `pending_approval`, `rejected`, revoked or inactive devices cannot synchronize.
- The local UI remains available while approval is pending. SQLite and the Outbox are not cleared, acknowledged or discarded by enrollment, approval or network failures.
- Only after the server reports `approved` does Electron permit sync.
- Every `/sync/pull` and `/sync/push` request carries `X-Device-Id` and a fresh ES256 `X-Device-Proof` bound to the bearer JWT (`ath`), method, path, timestamp and UUID `jti`.
- The private key never enters the renderer and is never logged or transmitted.

## Identity note

The stored fingerprint is a random, persistent installation identifier, not a claim of hardware attestation. Hostname, OS platform, architecture and OS release are sent separately as descriptive hardware information. A stronger hardware-backed identity would require a platform-specific TPM/secure-enclave integration and a separate attestation design.

## Required validation

CI must apply migrations through 035 on real PostgreSQL Testcontainers and verify concurrent one-time redemption, invalid proof non-consumption, tenant binding, atomic rollback, credential/audit creation, restricted direct grants, Electron proof signing, encrypted credential persistence, approval gating, and signed pull/push requests.
