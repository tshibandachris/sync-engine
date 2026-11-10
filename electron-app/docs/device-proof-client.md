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

The preload exposes read-only metadata through `getDeviceStatus()` and a status-refresh action. Private key material and the credential store remain in the main process. The SQLite `sync/outbox.cjs` contract is unchanged: failed requests leave queued operations available for retry, and the persisted idempotency key is reused for the same push batch.

**Signed synchronization transport:** the Electron main process now supplies the enrolled device ID and decrypted-in-memory private key to `sync/api-client.cjs`. Each `POST /sync/pull` and `POST /sync/push` gets a fresh ES256 proof containing `jti`, `htm`, `htu`, `iat`, and `ath` (SHA-256/base64url of the bearer token). The transport sends `X-Device-Id` and `X-Device-Proof`; the private key never leaves Main or enters request bodies/headers. `deviceProofReady` becomes true only after the encrypted credential has been loaded or saved and validated. Actual synchronization still requires the server-reported approved state and active credential. A network error or server rejection pauses sync while preserving the local POS and Outbox.


## Initial proof enrollment (client tranche)

- The Renderer submits only an activation code and a human-readable device name through a narrow IPC method.
- Electron Main generates a fresh P-256 key pair, derives the RFC 7638 thumbprint, builds the host fingerprint and signs the initial compact JWS.
- The initial proof binds `POST`, `/api/v1/devices/enroll`, `iat`, `jti`, SHA-256/base64url of the activation code, and the exact fingerprint sent in `X-Device-Fingerprint`.
- A dedicated enrollment transport posts `publicKeyPem` and `initialProof` to the backend. It does not send the agent bearer JWT.
- Before the network call, Main persists the exact activation code, key pair, thumbprint, fingerprint and stable `jti` in a separate OS-encrypted pending-attempt envelope before network I/O. Each retry creates a fresh `iat` and signature while retaining the same `jti`, key and code binding, so it remains inside the server's ±60-second proof window. The server's migration 035 idempotency receipt returns the same device/credential for that exact enrollment identity; a different proof cannot reuse the consumed code.
- On a matching server response, Main stores `deviceId` + private/public key + thumbprint in one OS-encrypted safeStorage credential, reads it back, clears the pending-attempt envelope, and only then changes the local trust state to `awaiting_approval`.
- The status poller starts after the encrypted credential has been verified. The server remains the sole authority for later approval transitions.
- The Renderer never receives the private key, the signed proof, or the public-key persistence envelope.

After this tranche, `deviceProofReady` reflects the presence of a successfully loaded or saved encrypted ES256 credential. Enrollment alone still does not enable synchronization: the server must independently report that the terminal is active, approved, and has an active credential. Each pull and push then carries a fresh request-bound proof. The SQLite Outbox and local POS path remain unchanged.
