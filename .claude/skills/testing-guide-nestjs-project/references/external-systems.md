> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

> Revised in Phase 03 (`docs/phases/phase-03-videos/validation.md`, IC-1). The earlier "local filesystem adapter" strategy could not exercise presigned multipart uploads nor storage-served Range requests, which are the core of `phase-03-videos/TD-02` and `TD-08`.

**Strategy:** S3 API everywhere. MinIO (`minio` service in `compose.yaml`) in development and tests, AWS S3 in production — same `@aws-sdk/client-s3` code path, no filesystem adapter, no mocks.

**Approach:**
- Tests talk to the real `minio` service using the env vars from `.env` (`S3_ENDPOINT=http://minio:9000`, bucket `S3_BUCKET`). The bucket is created by the one-shot `minio-init` service.
- Client-facing presigned URLs are signed for `S3_PUBLIC_ENDPOINT` (`http://minio.localhost:9000`); the `minio` service has the network alias `minio.localhost`, so tests running inside the `nestjs-api` container can call those URLs exactly like a browser on the host would.
- Use unique keys per test (e.g., a fresh UUID prefix) and delete the objects you created in `afterEach`/`afterAll`.
- Test media is generated at test time with `ffmpeg -f lavfi -i testsrc=…` (FFmpeg is installed in the dev image) — do not commit binary fixtures.

**Integration test sketch:**
```typescript
describe('StorageService (integration)', () => {
  it('uploads a part through a presigned URL and completes the object', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1);
    const res = await fetch(url, { method: 'PUT', body: buffer });
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: res.headers.get('etag')! },
    ]);
    expect((await storage.headObject(key))?.contentLength).toBe(buffer.length);
  });
});
```

---

## Message Queue — Real Redis + BullMQ (Docker)

> Technology decided in Phase 03 (`phase-03-videos/TD-01`): BullMQ on Redis (`redis` service in `compose.yaml`).

**Strategy:** Real broker in Docker. The `video-worker` Compose service consumes the `video-processing` queue continuously, so tests must not assume a job stays in `waiting`.

**Guidelines:**
- **Publisher tests:** look the job up by its deterministic id (`queue.getJob(videoId)`) and assert `data`/`opts` — never `getJobs(['waiting'])`, because the running worker may already have taken it.
- **Consumer tests:** call the processor's `process(job)` directly with a real DB, real MinIO and real FFmpeg (per `artifacts/future-types.md`); assert the DB status and the stored objects.
- **E2E:** drive the full flow through HTTP and poll the status endpoint until the worker container finishes (bounded timeout).
- The consumer is idempotent (acts only on videos in `processing`), so jobs enqueued by a test whose rows were already cleaned are discarded by the worker without side effects.

**Setup pattern:**
```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
}),
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
