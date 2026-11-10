# Device proof client foundation

The Electron main process now has a cryptographic foundation for the server's ES256 device-proof contract:

- \`electron/auth/device-crypto.cjs\` creates P-256 keys, computes an RFC 7638 JWK thumbprint, and signs compact ES256 proofs using 64-byte IEEE P1363 signatures.
- \`electron/auth/device-credential-store.cjs\` stores the device ID and key material in one OS-encrypted \`safeStorage\` envelope. It rejects plaintext/unknown storage backends, corrupted data, mismatched key pairs, and thumbprint mismatches.
- Private key material is intended to remain in the Electron main process; it must never be sent to the renderer.

## Signed sync request integration

The Electron main process now signs every supported synchronization request with the locally stored ES256 device key:

- `POST /sync/pull` and `POST /sync/push` each receive `X-Device-Id` and `X-Device-Proof` in addition to the agent Bearer JWT.
- The compact JWS uses `ES256` / `dpop+jwt` and binds the HTTP method, exact URL path, Unix `iat`, a fresh UUID `jti`, and the base64url SHA-256 digest of the exact Bearer token (`ath`).
- Every HTTP attempt creates a fresh proof and nonce. A push retry retains the persisted Outbox `Idempotency-Key` and exact batch snapshot while using a new proof `jti`.
- The private key remains in Electron Main and is never included in request bodies, headers, preload APIs, or Renderer state.
- This is the repository's own ES256 proof protocol; it is not represented as RFC 9449 DPoP compliance.

The backend `DeviceProofGuard` checks the exact method/path, token binding, timestamp, active credential, ES256 signature and replay nonce before allowing the sync controller to run. Approval and active credential state are obtained independently from the authenticated device-status endpoint. The client enables synchronization only when the agent is authenticated, the server reports the device approved and an active credential present, and the encrypted local credential has passed key-pair/thumbprint validation.

## Local operation and device trust state separation

The Electron main process now tracks the agent session and terminal trust independently:

- `agentAuthState`: `unauthenticated` or `authenticated`.
- `deviceTrustState`: `unregistered`, `awaiting_approval`, `approved`, `rejected`, `revoked`, or `deactivated`.
- `syncState`: includes explicit blocked states for approval, rejection, revocation, deactivation, and unavailable ES256 proof transport.

An authenticated agent can continue using local POS regardless of terminal trust. A local encrypted key never implies server approval. The main process obtains trust transitions only from the authenticated, tenant-scoped `GET /api/v1/devices/status` response; the server response is held in memory and is not copied into the local credential as an authority.

The status endpoint is deliberately protected by `JwtAuthGuard` but not `DeviceApprovalGuard`, so pending and rejected terminals can query their status. It requires `X-Device-Id`, scopes the query to the tenant from the verified JWT, applies PostgreSQL RLS, returns 404 for a device outside that tenant, and reports active credential availability separately from approval status.

The preload exposes read-only metadata through `getDeviceStatus()` and a status-refresh action. Private key material and the credential store remain in the main process. The `sync/api-client.cjs` now signs pull/push requests; `sync/outbox.cjs` remains unchanged. Resilience tests continue to exercise real `pushChanges()` HTTP rejection paths (401, 403 and network failure), persisted outbox rows and batch snapshots across SQLite close/reopen, and idempotency-key reuse.

**Integration boundary:** approval status alone does not activate synchronization. The client deliberately keeps `deviceProofReady` false and does not enable sync until the ES256 enrollment/initial-proof and signed-request protocol is implemented end to end. Thus an approved terminal still operates locally without making unsigned requests to proof-protected routes.


## Initial proof enrollment (client tranche)

- The Renderer submits only an activation code and a human-readable device name through a narrow IPC method.
- Electron Main generates a fresh P-256 key pair, derives the RFC 7638 thumbprint, builds the host fingerprint and signs the initial compact JWS.
- The initial proof binds `POST`, `/api/v1/devices/enroll`, `iat`, `jti`, SHA-256/base64url of the activation code, and the exact fingerprint sent in `X-Device-Fingerprint`.
- A dedicated enrollment transport posts `publicKeyPem` and `initialProof` to the backend. It does not send the agent bearer JWT.
- Before the network call, Main persists the exact activation code, key pair, thumbprint, fingerprint and stable `jti` in a separate OS-encrypted pending-attempt envelope before network I/O. Each retry creates a fresh `iat` and signature while retaining the same `jti`, key and code binding, so it remains inside the server's ±60-second proof window. The server's migration 035 idempotency receipt returns the same device/credential for that exact enrollment identity; a different proof cannot reuse the consumed code.
- On a matching server response, Main stores `deviceId` + private/public key + thumbprint in one OS-encrypted safeStorage credential, reads it back, clears the pending-attempt envelope, and only then changes the local trust state to `awaiting_approval`.
- The status poller starts after the encrypted credential has been verified. The server remains the sole authority for later approval transitions.
- The Renderer never receives the private key, the signed proof, or the public-key persistence envelope.

Enrollment and approval alone do not enable synchronization. The client also requires a verified local ES256 key and a server-confirmed active credential. A failed or rejected sync request leaves the SQLite Outbox batch intact; local POS operations remain available independently of server authorization.
