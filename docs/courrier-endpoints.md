# Courrier HTTP API

All routes are protected by the existing `JwtAuthGuard`. The guard validates the bearer JWT and derives `agentId` from `sub` and `tenantId` from the configured tenant claim. Client-supplied tenant or agent identifiers are never accepted as authority.

## Routes

- `POST /courriers` — create a courrier. JSON: `subject`, optional `body`, optional `confidentiality`.
- `GET /courriers?limit=50` — list visible records; limit 1–100.
- `GET /courriers/:id` — read one visible record.
- `POST /courriers/:id/assignments` — assign to exactly one `agent_id` or `service_id` (camelCase aliases accepted).
- `GET /courriers/:id/assignments` — list assignment history, including revoked assignments.
- `POST /courriers/:id/assignments/:assignmentId/revoke` — revoke an active assignment.
- `POST /courriers/:id/transitions` — request a controlled state transition with JSON `{ "to_status": "en_cours" }` (also accepts `toStatus`).
- `GET /courriers/:id/audit?limit=50` — read the audit trail; requires `courrier:manage`.
- `POST /courriers/:id/attachments/request-upload` — request a presigned upload URL. JSON accepts `contentType`/ `content_type`, `sizeBytes`/ `size_bytes`, and `checksumSha256`/ `checksum_sha256`.
- `POST /courriers/:id/attachments/:attachmentId/confirm` — confirm that the object exists in S3.
- `GET /courriers/:id/attachments` — list uploaded attachments and short-lived download URLs.

Allowed confidentiality values: `public`, `interne`, `confidentiel`, `secret`. Allowed attachment types: PDF, JPEG, PNG; maximum size 10 MiB. Upload URLs expire after 15 minutes; download URLs expire after 60 minutes.

## Authorization claims

The token must carry explicit permissions in a `permissions` array or a space-delimited `scope` string. Supported values are defined in `src/courrier-policy.ts`. A wildcard permission (`*`) is treated as administrator access by the existing policy. Optional `service_ids` is used to authorize access through active service assignments.

No permission is inferred from agent ID, tenant ID, or client request fields. Without explicit permissions, access is denied. Assignment targets are tenant-scoped, must contain exactly one agent or service, and are authorized using the verified token's permissions. Allowed forward transitions are `enregistre → affecte → en_cours → repondu → clos → archive`; skipped, repeated, backward, and unknown transitions are rejected. Assignment changes, state transitions, record reads, attachment actions, and audit reads append audit events. The runtime role can insert and read audit events but cannot update or delete them.
