# Render Free deployment — guarded runbook

This runbook prepares a **test-only** Render deployment. Do not use the Free database or Free web service for real business/customer data.

## Current architecture blockers

The application must not be exposed publicly until all of these are resolved:

1. **PostgreSQL migrations:** run `.github/workflows/render-postgres-migrations.yml` manually from GitHub Actions. The workflow is intentionally manual and checks the database name, TLS, and `CREATEROLE` before running `scripts/migrate.sh`.
2. **Database identities:** the migration creates/updates three separate logins: `sync_app`, `device_enrollment_login`, and `device_admin_login`. The API must use three separate connection URLs. Never put the Render owner/admin connection URL in the Web Service environment.
3. **Identity provider:** production boot guards require `JWKS_URL` and `JWT_AUDIENCE`, Shared-secret mode is forbidden in production; startup fails if it is enabled. Configure a real OIDC/JWKS issuer before public deployment. Configure a real OIDC/JWKS issuer before public deployment.
4. **S3-compatible object storage:** the app requires a bucket and S3 credentials. The Compose SeaweedFS container is not part of Render. Configure an external S3-compatible service and ensure `S3_PUBLIC_ENDPOINT` is reachable by mobile clients over HTTPS. Do not use localhost or an internal-only hostname for presigned URLs.
5. **Maintenance:** `maintenance-runner.js` is a separate batch process, run by `.github/workflows/maintenance-purge.yml` (daily at 03:17 UTC). The workflow uses a dedicated `maintenance_login` role and bucket-scoped R2 credentials. GitHub-hosted runner IPs change, so use Render's external PostgreSQL URL with TLS; do not put this credential in the API service environment. Scheduled workflows run from the default branch, so this workflow is not active until it is merged to the default branch.

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
- `MAINTENANCE_PASSWORD` — long, unique password for the dedicated `maintenance_login` role

Use long, unique random values for all four application passwords. Never commit them, paste them into issues/PR comments, or send them in chat. The migration workflow must stop if the Render database user lacks the required role-management capability.

The workflow applies the repository's 41 SQL migration files, provisions `maintenance_login` with membership only in `maintenance_purge_executor`, and verifies the migration ledger. A successful workflow run is required before starting the API. The maintenance login is not an API credential.

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
| `JWT_SECRET` | Development-only local signing secret; do not configure shared-secret auth in production |
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

Do not set `AUTH_ALLOW_SHARED_SECRET=true` in production. The boot guard rejects it. Do not expose `METRICS_PORT` publicly.

## Scheduled maintenance secrets and network access

Add these **GitHub Actions secrets** for `.github/workflows/maintenance-purge.yml`:

- `RENDER_MAINTENANCE_DATABASE_URL`: Render **External Database URL** using username `maintenance_login`, with `sslmode=require`. This role is provisioned by the migration workflow. GitHub-hosted runner IP addresses are dynamic; do not pin a short-lived runner IP. The database must permit external TLS connections.
- `R2_BUCKET`: exact bucket name.
- `R2_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com`.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: S3 API token credentials with **Object Read & Write** permission scoped to this bucket only.

The maintenance role has no direct SELECT/DELETE rights on tenant tables. It can enumerate tenant UUIDs and execute only the narrowly granted maintenance functions; those functions enforce tenant context and the database retains FORCE RLS. The maintenance runner verifies that its current database user is exactly `maintenance_login`. Never reuse `sync_app`, the Render owner user, or an API connection string.

The workflow is scheduled at 03:17 UTC and can also be manually dispatched. GitHub only runs scheduled workflows from the default branch; the file must reach that branch before the schedule becomes active.

## Supabase Auth

See [Supabase Auth setup](supabase-auth.md). Production requires an asymmetric ES256/RS256 signing key and a Custom Access Token Hook that copies `agent_id` and `tenantId` from server-managed `app_metadata`. User-editable `user_metadata` is never an identity source. The free Supabase project is for testing only; upgrade before a live commercial pilot.

## Important Free-plan limitations

- Free web services sleep after 15 minutes without inbound traffic and can take about a minute to wake.
- Their filesystem is ephemeral.
- Free Postgres is limited to 1 GB, expires after 30 days, has no backups, and is deleted after the post-expiry grace period if not upgraded.
- Free web services do not support one-off jobs or SSH.
- Render Cron Jobs and pre-deploy commands are not available on the Free web-service plan.

This environment is for a disposable integration test only. Upgrade and define backups, monitoring, identity, object storage, and maintenance scheduling before any production use.


## Rollback and recovery

Render Free Postgres has no backups. There is no safe production rollback path for schema changes on a Free database. This runbook is test-only: for a failed disposable test, recreate the test database and replay the complete migration chain. Never attempt ad-hoc reverse SQL against a real database. Before production, use a paid database with verified backups and a tested restore procedure; take a backup before every schema change.
