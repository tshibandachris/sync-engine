# Courrier HTTP API

All routes are protected by the existing `JwtAuthGuard`. The guard validates the bearer JWT and derives `agentId` from `sub` and `tenantId` from the configured tenant claim. Client-supplied tenant or agent identifiers are never accepted as authority.

## Routes

- `POST /courriers` — create a courrier. JSON: `subject`, optional `body`, optional `confidentiality`.
- `GET /courriers?limit=50` — list visible records; limit 1–100.
- `GET /courriers/:id` — read one visible record.
- `POST /courriers/:id/attachments/request-upload` — request a presigned upload URL. JSON accepts `contentType`/ `content_type`, `sizeBytes`/ `size_bytes`, and `checksumSha256`/ `checksum_sha256`.
- `POST /courriers/:id/attachments/:attachmentId/confirm` — confirm that the object exists in S3.
- `GET /courriers/:id/attachments` — list uploaded attachments and short-lived download URLs.

Allowed confidentiality values: `public`, `interne`, `confidentiel`, `secret`. Allowed attachment types: PDF, JPEG, PNG; maximum size 10 MiB. Upload URLs expire after 15 minutes; download URLs expire after 60 minutes.

## Authorization claims

The token must carry explicit permissions in a `permissions` array or a space-delimited `scope` string. Supported values are defined in `src/courrier-policy.ts`. A wildcard permission (`*`) is treated as administrator access by the existing policy. Optional `service_ids` is parsed for future service assignment rules.

No permission is inferred from agent ID, tenant ID, or client request fields. Without explicit permissions, access is denied. Assignment tables and workflow-transition endpoints are intentionally not fabricated in this stage; until those are modelled, creator/clearance policy is applied and the policy receives no synthetic assignments.
