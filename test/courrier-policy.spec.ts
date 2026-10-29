import { describe, expect, it } from 'vitest';
import {
  canActOnMail,
  canReadMail,
  effectiveClearance,
  filterVisibleMails,
  requireConfidentiality,
  type CourrierAccessContext,
  type CourrierRecord,
} from '../src/courrier-policy.js';

const baseContext = (overrides: Partial<CourrierAccessContext> = {}): CourrierAccessContext => ({
  tenantId: 'tenant-a',
  actorId: 'agent-a',
  permissions: new Set(['courrier:read']),
  clearance: 'interne',
  ...overrides,
});

const mail = (overrides: Partial<CourrierRecord> = {}): CourrierRecord => ({
  id: 'mail-a',
  tenantId: 'tenant-a',
  createdBy: 'creator',
  confidentiality: 'secret',
  ...overrides,
});

describe('Courrier policy — fail-closed authorization', () => {
  it('rejects an unknown confidentiality value at the input boundary', () => {
    expect(() => requireConfidentiality('unknown')).toThrow(/confidentialité invalide/i);
  });

  it('keeps malformed clearance at the baseline and does not elevate it', () => {
    expect(effectiveClearance(new Set(['clearance:secret']), 'invalid')).toBe('interne');
  });

  it('gives wildcard administrators the secret clearance implied by all permissions', () => {
    expect(effectiveClearance(new Set(['*']), 'interne')).toBe('secret');
  });

  it('denies records from another tenant even if the actor is assigned', () => {
    const crossTenantMail = mail({ tenantId: 'tenant-b' });
    expect(canReadMail(baseContext(), crossTenantMail, [{
      tenantId: 'tenant-b', mailId: 'mail-a', userId: 'agent-a',
    }])).toBe(false);
  });

  it('does not let a service assignment from another tenant grant access', () => {
    const confidentialMail = mail({ confidentiality: 'confidentiel' });
    expect(canReadMail(
      baseContext({ serviceIds: new Set(['service-a']) }),
      confidentialMail,
      [{ tenantId: 'tenant-b', mailId: 'mail-a', serviceId: 'service-a' }],
    )).toBe(false);
  });

  it('requires membership in the exact assigned service for confidential mail', () => {
    const confidentialMail = mail({ confidentiality: 'confidentiel' });
    const assignment = [{ tenantId: 'tenant-a', mailId: 'mail-a', serviceId: 'service-a' }];
    expect(canReadMail(baseContext(), confidentialMail, assignment)).toBe(false);
    expect(canReadMail(
      baseContext({ serviceIds: new Set(['service-a']) }),
      confidentialMail,
      assignment,
    )).toBe(true);
  });

  it('allows a directly assigned user to read the exact mail within their tenant', () => {
    expect(canReadMail(baseContext(), mail(), [{
      tenantId: 'tenant-a', mailId: 'mail-a', userId: 'agent-a',
    }])).toBe(true);
  });

  it('never grants secret-mail access through service assignment alone', () => {
    expect(canReadMail(
      baseContext({ serviceIds: new Set(['service-a']) }),
      mail(),
      [{ tenantId: 'tenant-a', mailId: 'mail-a', serviceId: 'service-a' }],
    )).toBe(false);
  });

  it('filters lists with the same visibility rule as detail access', () => {
    const visible = mail({ id: 'visible', confidentiality: 'interne' });
    const hidden = mail({ id: 'hidden', confidentiality: 'secret' });
    expect(filterVisibleMails(baseContext(), [visible, hidden], []).map((item) => item.id))
      .toEqual(['visible']);
  });

  it('does not allow an unassigned reader to close someone else’s mail', () => {
    expect(canActOnMail(baseContext(), mail({ confidentiality: 'interne' }), [], 'close'))
      .toBe(false);
  });
});
