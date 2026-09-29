import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AuthController } from '../src/auth.controller.js';
import { TEST_JWT_SECRET, createTestJwtService } from './helpers/jwt.js';

describe('POST /auth/token', () => {
  let app: INestApplication;
  const agentId = randomUUID();

  beforeAll(async () => {
    process.env.AUTH_ALLOW_DEV_TOKEN = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [AuthController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a valid JWT for a UUID agent_id', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/token')
      .send({ agent_id: agentId });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.expires_in).toBe(30 * 24 * 3600);
    expect(res.body.agent_id).toBe(agentId);

    const verify = createTestJwtService();
    const payload = verify.verify(res.body.token) as { sub: string };
    expect(payload.sub).toBe(agentId);
  });

  it('rejects a non-UUID agent_id', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/token')
      .send({ agent_id: 'agent-42' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing agent_id', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/token')
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects when AUTH_ALLOW_DEV_TOKEN is false', async () => {
    process.env.AUTH_ALLOW_DEV_TOKEN = 'false';

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [AuthController],
    }).compile();

    const isolatedApp = moduleRef.createNestApplication();
    await isolatedApp.init();

    const res = await request(isolatedApp.getHttpServer())
      .post('/auth/token')
      .send({ agent_id: agentId });

    expect(res.status).toBe(403);

    await isolatedApp.close();
    process.env.AUTH_ALLOW_DEV_TOKEN = 'true';
  });
});