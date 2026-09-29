import { JwtService } from '@nestjs/jwt';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-prod';

export function createTestJwtService(): JwtService {
  return new JwtService({
    secret: TEST_JWT_SECRET,
    signOptions: { expiresIn: '30d' },
  });
}

export function signAgentToken(agentId: string, jwt: JwtService): string {
  return jwt.sign({ sub: agentId });
}

export function signExpiredToken(agentId: string, jwt: JwtService): string {
  return jwt.sign({ sub: agentId }, { expiresIn: '-1s' });
}

export function signInvalidToken(): string {
  const other = new JwtService({
    secret: 'wrong-secret',
    signOptions: { expiresIn: '30d' },
  });
  return other.sign({ sub: '00000000-0000-0000-0000-000000000000' });
}