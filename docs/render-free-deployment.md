# Render Free deployment — guarded runbook

This runbook prepares a **test-only** Render deployment. Do not use the Free database or Free web service for real business/customer data.

## Current architecture blockers

The application must not be exposed publicly until all of these are resolved:

1. **PostgreSQL migrations:** run `.github/workflows/render-postgres-migrations.yml` manually from GitHub Actions. The workflow is intentionally manual and checks the database name, TLS, and `CREATEROLE` before running `scripts/migrate.sh`.
2. **Database identities:** the migration creates/updates three separate logins: `sync_app`, `device_enrollment_login`, and `device_admin_login`. The API must use three separate connection URLs. Never put the Render owner/admin connection URL in the Web Service environment.
3. **Identity provider:** production boot guards require `JWKS_URL` and `JWT_AUDIENCE`, unless the operator explicitly opts into shared-secret mode. Shared-secret mode grants broad tenant access to anyone holding the secret and is not an appropriate default for a public internet-facing service. Configure a real OIDC/JWKS issuer before public deployment.
4. **S3-compatible object storage:** the app requires a bucket and S3 credentials. The Compose SeaweedFS container is not part of Render. Configure an external S3-compatible service and ensure `S3_PUBLIC_ENDPOINT` is reachable by mobile clients over HTTPS. Do not use localhost or an internal-only hostname for presigned URLs.
5. **Maintenance:** `maintenance-runner.js` is a separate batch process. The Free web service cannot run one-off jobs and Render Cron Jobs are not a Free service type. Do not silently move destructive maintenance into the API startup path. Until a scheduler is selected, schedule no destructive purge; review maintenance reports separately.

## GitHub migration workflow

The workflow is `workflow_dispatch` only. GitHub requires a manually dispatched workflow to exist on the repository's default branch before it can be dispatched. This PR is stacked on the device-security PR; do not expect the workflow to be manually runnable until the required PR changes have reached the default branch.

Create these **repository Actions secrets** only after confirming the database Info page and the external connection details:

- `RENDER_DB_HOST`
- `RENDER_DB_PORT`
- `RENDER_DB_NAME` — must be `sync_engine`
- `RENDER_DB_USER`
- `RENDER_DB_PASSWORD`
- `SYNC_APP_PASSWORD`
- `DEVICE_ENROLLMENT_PASSWORD`
- `DEVICE_ADMIN_PASSWORD`

Use long, unique random values for the three application passwords. Never commit them, paste them into issues/PR comments, or send them in chat. The migration workflow must stop if the Render database user lacks the required role-management capability.

The workflow applies the repository's 39 SQL migration files and verifies the migration ledger. A successful workflow run is required before starting the API.

## Render Web Service configuration (after the blockers are resolved)

- Service name: `eden-sync-engine`
- Runtime: Docker, using the repository `Dockerfile`
- Region: Frankfurt, same region as `eden-sync-engine-db`
- Plan: Free for temporary testing only
- Health check: configure only after a stable health endpoint has been verified in the application
- Auto-deploy: keep disabled until the deployment PR is reviewed and the intended branch is selected

Required environment variables:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Let Render provide its assigned port |
| `DATABASE_URL` | Internal PostgreSQL URL using `sync_app` |
| `DEVICE_ENROLLMENT_DATABASE_URL` | Internal PostgreSQL URL using `device_enrollment_login` |
| `DEVICE_ADMIN_DATABASE_URL` | Internal PostgreSQL URL using `device_admin_login` |
| `JWT_SECRET` | Strong random value; required by current bootstrap even in JWKS mode |
| `JWKS_URL` | HTTPS JWKS endpoint of the selected OIDC provider |
| `JWT_AUDIENCE` | Audience expected by the API |
| `JWT_ISSUER` | Set to the issuer expected by the chosen provider/configuration |
| `S3_BUCKET` | Existing bucket name |
| `S3_REGION` | S3 region (provider-specific) |
| `S3_ENDPOINT` | S3 API endpoint |
| `S3_PUBLIC_ENDPOINT` | Public HTTPS endpoint used to sign client upload/download URLs |
| `S3_ACCESS_KEY_ID` | Restricted bucket credential |
| `S3_SECRET_ACCESS_KEY` | Restricted bucket credential |
| `METRICS_PORT` | Dedicated non-public metrics listener port, distinct from `PORT` |
| `OPS_METRICS_TOKEN` | Random token, at least 32 characters |
| `TRUST_PROXY_HOPS` | Set only after verifying Render's proxy topology and the required hop count |

Do not set `AUTH_ALLOW_SHARED_SECRET=true` for a public service without an explicit security review. Do not expose `METRICS_PORT` publicly.

## Important Free-plan limitations

- Free web services sleep after 15 minutes without inbound traffic and can take about a minute to wake.
- Their filesystem is ephemeral.
- Free Postgres is limited to 1 GB, expires after 30 days, has no backups, and is deleted after the post-expiry grace period if not upgraded.
- Free web services do not support one-off jobs or SSH.
- Render Cron Jobs and pre-deploy commands are not available on the Free web-service plan.

This environment is for a disposable integration test only. Upgrade and define backups, monitoring, identity, object storage, and maintenance scheduling before any production use.
