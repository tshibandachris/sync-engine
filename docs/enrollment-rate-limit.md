# Device enrollment rate limiting

The public `POST /api/v1/devices/enroll` endpoint is guarded independently from POS synchronization routes.

## Policy

- 5 requests per IP per 60 seconds; the sixth request is rejected with HTTP 429.
- 20 requests per IP per hour as a second, longer window.
- The Nest throttler uses in-memory storage when `REDIS_URL` is unset (local development only).
- When `REDIS_URL` is configured, a Redis-backed storage implementation uses an atomic Lua script so multiple API instances share counters.
- If Redis is configured but unavailable at startup, application startup fails rather than silently downgrading to process-local limits.

## Environment

```dotenv
# Production: shared Redis instance reachable by every API instance
REDIS_URL=redis://redis:6379

# Only set when requests pass through a known, fixed number of trusted proxies.
# Example: one reverse proxy in front of the API.
TRUST_PROXY_HOPS=1
```

Leave `TRUST_PROXY_HOPS` unset (or set it to `0`) when the API is accessed directly. Set it to the exact number of trusted proxy hops; do not use Express' `trust proxy = true` on a publicly reachable service. The reverse proxy must overwrite incoming forwarding headers rather than forwarding client-supplied values unchanged.

## Operational notes

- Do not set `REDIS_URL` in multi-instance production unless Redis is shared by all instances.
- Keep the enrollment-specific guard on the enrollment handler; do not register it as `APP_GUARD`.
- The IP limit is a first barrier, not the only abuse control. Add per-code failed-attempt limits and edge/WAF protection before exposing enrollment broadly.
- Do not log raw activation codes. Monitor 429 counts and Redis connection failures.
- The Supertest integration test forces in-memory storage for deterministic CI and verifies the nominal response, the sixth-request 429, and that `/sync/pull` is not throttled by the enrollment guard.
