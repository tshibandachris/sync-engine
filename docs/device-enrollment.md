# Device enrollment

The public endpoint `POST /api/v1/devices/enroll` accepts:

```json
{
  "activationCode": "ED26-89AB",
  "deviceName": "Caisse principale",
  "hardwareInfo": {
    "hostname": "POS-01",
    "platform": "win32",
    "arch": "x64",
    "osRelease": "10.0"
  }
}
```

Send the hardware fingerprint in `X-Device-Fingerprint`. It is a device identifier, not proof of identity; the server validates its presence and stores it tenant-scoped.

## One-time code contract

The code issuer must normalize the code to uppercase and store the lowercase hexadecimal SHA-256 digest of the exact UTF-8 value in `device_pairing_codes.code_hash`. The activation code format is `XXXX-XXXX`.

Redemption is a PostgreSQL conditional UPDATE inside the same transaction as device insertion. The narrow `redeem_device_pairing_code(text)` SECURITY DEFINER function avoids granting the unauthenticated API role direct read/update access to codes. If the device insert fails, PostgreSQL rolls back the code consumption too. Concurrent requests for one code cannot both succeed.

## Token issuance boundary

This endpoint currently records the enrolled device and returns its identity/store metadata; it does **not** issue access or refresh tokens. Production authentication in this repository validates tokens from the configured external JWKS issuer. Signing a token with the local `JWT_SECRET` would not produce a token accepted by that production verifier, so token issuance must be integrated with the configured identity provider before an enrolled device can authenticate to sync endpoints.

## Deployment notes

- Apply migrations `029_create_device_pairing_codes.sql` and `030_create_enrolled_devices.sql` before enabling the endpoint.
- The system that issues pairing codes must use the exact hash contract above.
- Add centrally enforced per-IP/device rate limiting before exposing enrollment on an untrusted public network. The fingerprint header is client-supplied and must not be treated as a security credential.
