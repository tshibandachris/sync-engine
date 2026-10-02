import { BadRequestException } from '@nestjs/common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * Refuse a missing or malformed tenant id at the service boundary.
 *
 * The HTTP path always goes through the JWT guard, which validates the
 * tenant claim. But services are also called from tests, jobs, and future
 * controllers. A silent fallback to a default tenant would write to the
 * wrong tenant without an error. Fail closed instead.
 */
export function requireTenantId(value: unknown, field = 'tenantId'): string {
  if (value === undefined || value === null) {
    throw new BadRequestException(
      field + " requis : refus d'un contexte tenant implicite.",
    );
  }
  const s = String(value);
  if (!UUID_RE.test(s)) {
    throw new BadRequestException(field + ' doit etre un UUID.');
  }
  return s;
}
