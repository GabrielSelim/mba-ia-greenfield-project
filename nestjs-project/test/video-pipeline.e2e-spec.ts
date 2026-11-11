import { randomBytes } from 'node:crypto';
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
import videoConfig from '../src/config/video.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateTestVideo } from '../src/test/test-media';

const MIB = 1024 * 1024;
const PART_SIZE = 5 * MIB;
const PROCESSING_TIMEOUT_MS = 90_000;

/**
 * Full pipeline through the real Compose services: the API (this process),
 * MinIO (presigned uploads/downloads), Redis (queue) and the `video-worker`
 * container, which consumes the job and updates the database.
 * Requires `docker compose up -d` (video-worker running).
 */
describe('Video pipeline (e2e — real worker container)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;

  const http = () => request(app.getHttpServer());

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
    await http().post('/auth/register').send({ email, password }).expect(201);
    await http().get('/auth/confirm-email').query({ token }).expect(204);
    const res = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.access_token as string;
  }

  /** Client side of the TD-02 handshake: the API never receives the bytes. */
  async function uploadVideo(
    token: string,
    filename: string,
    body: Buffer,
  ): Promise<string> {
    const draft = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename, content_type: 'video/mp4', size_bytes: body.length })
      .expect(201);
    const { slug, upload } = draft.body as {
      slug: string;
      upload: { part_size: number; part_count: number };
    };
    const numbers = Array.from({ length: upload.part_count }, (_, i) => i + 1);
    const signed = await http()
      .post(`/videos/${slug}/upload-parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: numbers })
      .expect(200);

    const parts: { part_number: number; etag: string }[] = [];
    for (const part of signed.body.parts as {
      part_number: number;
      url: string;
    }[]) {
      const start = (part.part_number - 1) * upload.part_size;
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(body.subarray(start, start + upload.part_size)),
      });
      expect(res.status).toBe(200);
      parts.push({
        part_number: part.part_number,
        etag: res.headers.get('etag')!,
      });
    }

    const completed = await http()
      .post(`/videos/${slug}/complete-upload`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(200);
    expect(completed.body.status).toBe('processing');
    return slug;
  }

  async function waitForStatus(
    token: string,
    slug: string,
    expected: string[],
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    for (;;) {
      throttlerStorage.storage.clear();
      const res = await http()
        .get(`/videos/${slug}/status`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      if (expected.includes(res.body.status as string)) return res.body;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${slug}: ${res.body.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // 5 MiB parts: the ~12.8 MB sample is uploaded in 3 parts.
      .overrideProvider(videoConfig.KEY)
      .useValue({ ...videoConfig(), partSizeBytes: PART_SIZE })
      .compile();

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
    ownerToken = await registerConfirmAndLogin('pipeline-owner@example.com');
    otherToken = await registerConfirmAndLogin('pipeline-other@example.com');
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  it('should upload in parts, process in the worker and stream/download/thumbnail the video', async () => {
    const body = await generateTestVideo({
      width: 1280,
      height: 720,
      bitrate: '30M',
    });
    expect(body.length).toBeGreaterThan(2 * PART_SIZE); // 3 parts

    const slug = await uploadVideo(ownerToken, 'Férias na praia.mp4', body);
    const status = await waitForStatus(ownerToken, slug, ['ready', 'failed']);
    expect(status).toMatchObject({ status: 'ready', processing_error: null });

    // Unique URL, anonymous access (TD-07, TD-11)
    const video = await http().get(`/videos/${slug}`).expect(200);
    expect(video.body).toMatchObject({
      slug,
      title: 'Férias na praia',
      status: 'ready',
      size_bytes: body.length,
      channel: { nickname: 'pipelineowner' },
      metadata: { width: 1280, height: 720, video_codec: 'h264' },
    });
    expect(video.body.duration_seconds).toBeCloseTo(3, 0);

    // Streaming: the storage answers Range requests with 206 (TD-08)
    const stream = await http().get(`/videos/${slug}/stream`).expect(302);
    expect(new URL(stream.headers.location).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );
    const partial = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-1023/${body.length}`,
    );
    expect(partial.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(
      body.subarray(0, 1024),
    );

    // Download: attachment with the original (UTF-8) filename
    const download = await http().get(`/videos/${slug}/download`).expect(302);
    const file = await fetch(download.headers.location);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''F%C3%A9rias%20na%20praia.mp4",
    );
    expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);

    // Thumbnail generated from a frame
    const thumb = await http().get(`/videos/${slug}/thumbnail`).expect(302);
    const jpeg = await fetch(thumb.headers.location);
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await jpeg.arrayBuffer()).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );

    // Owner-only status
    await http().get(`/videos/${slug}/status`).expect(401);
    await http()
      .get(`/videos/${slug}/status`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  }, 180_000);

  it('should mark a non-video upload as failed and keep it private', async () => {
    const slug = await uploadVideo(
      ownerToken,
      'not-a-video.mp4',
      randomBytes(64 * 1024),
    );

    const status = await waitForStatus(ownerToken, slug, ['ready', 'failed']);

    expect(status.status).toBe('failed');
    expect(status.processing_error).toContain('not a playable video');
    const res = await http().get(`/videos/${slug}`).expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  }, 120_000);

  it('should hide drafts from the public routes', async () => {
    const draft = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'draft.mp4',
        content_type: 'video/mp4',
        size_bytes: 10,
      })
      .expect(201);
    const slug = draft.body.slug as string;

    for (const path of ['', '/stream', '/download', '/thumbnail']) {
      const res = await http().get(`/videos/${slug}${path}`).expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }
    const status = await http()
      .get(`/videos/${slug}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(status.body.status).toBe('draft');
  });
});
