# Device proof client foundation

The Electron main process now has a cryptographic foundation for the server's ES256 device-proof contract:

- \`electron/auth/device-crypto.cjs\` creates P-256 keys, computes an RFC 7638 JWK thumbprint, and signs compact ES256 proofs using 64-byte IEEE P1363 signatures.
- \`electron/auth/device-credential-store.cjs\` stores the device ID and key material in one OS-encrypted \`safeStorage\` envelope. It rejects plaintext/unknown storage backends, corrupted data, mismatched key pairs, and thumbprint mismatches.
- Private key material is intended to remain in the Electron main process; it must never be sent to the renderer.

## Deliberate integration boundary

This commit does **not** enable proof enforcement in \`sync/api-client.cjs\` yet. The existing activation UI only accepts an agent bearer JWT; it does not receive a server-issued device ID or register the generated public key as an active server credential. Wiring proof headers before the backend pairing/initial-proof transaction returns those values would create an unusable or misleading "ready" state.

The next activation tranche must atomically register the public key against the pending device, return the server device ID, persist the encrypted credential, and only then allow signed \`/sync/*\` calls. Local POS operations and the SQLite outbox remain independent of that server authorization state.


## Local operation and device trust state separation

The Electron main process now tracks the agent session and terminal trust independently:

- `agentAuthState`: `unauthenticated` or `authenticated`.
- `deviceTrustState`: `unregistered`, `awaiting_approval`, `approved`, `rejected`, `revoked`, or `deactivated`.
- `syncState`: includes explicit blocked states for approval, rejection, revocation, deactivation, and unavailable ES256 proof transport.

An authenticated agent can continue using local POS regardless of terminal trust. A local encrypted key never implies server approval. The main process obtains trust transitions only from the authenticated, tenant-scoped `GET /api/v1/devices/status` response; the server response is held in memory and is not copied into the local credential as an authority.

The status endpoint is deliberately protected by `JwtAuthGuard` but not `DeviceApprovalGuard`, so pending and rejected terminals can query their status. It requires `X-Device-Id`, scopes the query to the tenant from the verified JWT, applies PostgreSQL RLS, returns 404 for a device outside that tenant, and reports active credential availability separately from approval status.

The preload exposes read-only metadata through `getDeviceStatus()` and a status-refresh action. Private key material and the credential store remain in the main process. The existing `sync/api-client.cjs` and `sync/outbox.cjs` are unchanged. Resilience tests continue to exercise real `pushChanges()` HTTP rejection paths (401, 403 and network failure), persisted outbox rows and batch snapshots across SQLite close/reopen, and idempotency-key reuse.

**Integration boundary:** approval status alone does not activate synchronization. The client deliberately keeps `deviceProofReady` false and does not enable sync until the ES256 enrollment/initial-proof and signed-request protocol is implemented end to end. Thus an approved terminal still operates locally without making unsigned requests to proof-protected routes.
