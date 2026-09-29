import { JwtService } from '@nestjs/jwt';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-prod';
export const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export function createTestJwtService(): JwtService {
  return new JwtService({
    secret: TEST_JWT_SECRET,
    signOptions: { expiresIn: '30d' },
  });
}

export function signAgentToken(
  agentId: string,
  jwt: JwtService,
  tenantId: string = TEST_TENANT_ID,
): string {
  return jwt.sign({ sub: agentId, tenantId });
}

export function signExpiredToken(
  agentId: string,
  jwt: JwtService,
  tenantId: string = TEST_TENANT_ID,
): string {
  return jwt.sign({ sub: agentId, tenantId }, { expiresIn: '-1s' });
}

export function signInvalidToken(
  tenantId: string = TEST_TENANT_ID,
): string {
  const other = new JwtService({
    secret: 'wrong-secret',
    signOptions: { expiresIn: '30d' },
  });
  return other.sign({ sub: '00000000-0000-0000-0000-000000000000', tenantId });
}