import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token })
      .expect(204);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.access_token as string;
  }

  const validDraft = {
    filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: 12 * MIB,
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    await cleanAllTables(dataSource);
    ownerToken = await registerConfirmAndLogin('video-owner@example.com');
    otherToken = await registerConfirmAndLogin('video-other@example.com');
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  describe('POST /videos', () => {
    it('should create a draft and return the upload instructions', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraft)
        .expect(201);

      expect(res.body).toMatchObject({
        id: expect.any(String),
        slug: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        title: 'holiday',
        status: 'draft',
        size_bytes: 12 * MIB,
        content_type: 'video/mp4',
        upload: {
          part_size: 100 * MIB,
          part_count: 1,
          max_parts_per_request: 100,
        },
      });
    });

    it('should accept a 10 GiB declaration (103 parts of 100 MiB)', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ ...validDraft, size_bytes: 10 * GIB })
        .expect(201);

      expect(res.body.upload.part_count).toBe(103);
    });

    it('should reject 10 GiB + 1 byte with 422 VIDEO_TOO_LARGE', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ ...validDraft, size_bytes: 10 * GIB + 1 })
        .expect(422);

      expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    });

    it('should reject an unsupported content type and missing fields with 400', async () => {
      const badType = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ ...validDraft, content_type: 'application/pdf' })
        .expect(400);
      const missing = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content_type: 'video/mp4' })
        .expect(400);

      expect(badType.body.error).toBe('VALIDATION_ERROR');
      expect(missing.body.error).toBe('VALIDATION_ERROR');
    });

    it('should require an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validDraft)
        .expect(401);
    });
  });
});
