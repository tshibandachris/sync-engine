# Device proof client foundation

The Electron main process now has a cryptographic foundation for the server's ES256 device-proof contract:

- \`electron/auth/device-crypto.cjs\` creates P-256 keys, computes an RFC 7638 JWK thumbprint, and signs compact ES256 proofs using 64-byte IEEE P1363 signatures.
- \`electron/auth/device-credential-store.cjs\` stores the device ID and key material in one OS-encrypted \`safeStorage\` envelope. It rejects plaintext/unknown storage backends, corrupted data, mismatched key pairs, and thumbprint mismatches.
- Private key material is intended to remain in the Electron main process; it must never be sent to the renderer.

## Deliberate integration boundary

This commit does **not** enable proof enforcement in \`sync/api-client.cjs\` yet. The existing activation UI only accepts an agent bearer JWT; it does not receive a server-issued device ID or register the generated public key as an active server credential. Wiring proof headers before the backend pairing/initial-proof transaction returns those values would create an unusable or misleading "ready" state.

The next activation tranche must atomically register the public key against the pending device, return the server device ID, persist the encrypted credential, and only then allow signed \`/sync/*\` calls. Local POS operations and the SQLite outbox remain independent of that server authorization state.
