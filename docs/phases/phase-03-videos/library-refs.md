---
libs:
  "bullmq":
    version: "^6.7.4"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-11T13:58:40-04:00"
  "@nestjs/bullmq":
    version: "^12.0.1"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-11-11T13:58:40-04:00"
  "@aws-sdk/client-s3":
    version: "^3.1166.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-11T14:00:10-04:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1166.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-11T14:00:10-04:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T14:01:56-04:00"
---

# Library References — phase-03-videos

Cached Context7 excerpts for the libraries decided in this phase (fetched through the Context7 HTTP API, `GET /api/v2/context?libraryId=…`). Versions were checked against the npm registry on 2026-11-11 (`npm view <pkg> version` / `peerDependencies`) and against the installed stack in `nestjs-project/package-lock.json` (`@nestjs/core 11.1.16`, Node 25 image).

System binaries (not npm): `ffmpeg`/`ffprobe` installed from Debian packages in `Dockerfile.dev` (TD-05) — usage is plain CLI, no library docs cached.

---

## bullmq

**Version line:** `^6.7.4` (latest on npm; Context7 indexes `v6.5.3`). Requires Redis with `maxmemory-policy noeviction`.
**Decided in:** `phase-03-videos/TD-01` (A — BullMQ + Redis), `phase-03-videos/TD-09` (retries / unrecoverable failures).
**Context7 ID:** `/taskforcesh/bullmq`.

### 1. Retries with exponential backoff (job options)

```typescript
await queue.add(
  'test-retry',
  { foo: 'bar' },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, // 2^(attempts-1) * delay ms
  },
);
```

### 2. Stop retrying — `UnrecoverableError`

"Throwing `UnrecoverableError` in a worker moves the job to the failed set without retries, overriding any attempts settings."

```typescript
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('Unrecoverable');
```

### 3. Custom job ids (deduplication)

"By default, job ids are generated automatically as an increasing counter, however it is also possible to specify a custom id." Jobs added with an identical `jobId` are considered duplicates and are not added again. Uniqueness is scoped per queue.

> Warning from the docs: with `removeOnComplete`/`removeOnFail`, a removed job no longer counts as existing, so a new job with the same id can be added. Phase 03 relies on this only after the video left `processing` (the idempotent consumer ignores anything else — TD-09).

### 4. Failed event

```typescript
worker.on('failed', (job: Job, error: Error) => { /* job.attemptsMade, job.opts.attempts */ });
```

---

## @nestjs/bullmq

**Version line:** `^12.0.1` — peer dependencies `bullmq ^3 || ^4 || ^5 || ^6`, `@nestjs/core`/`@nestjs/common ^10 || ^11 || ^12` (compatible with the installed `11.1.16`).
**Decided in:** `phase-03-videos/TD-01`, `phase-03-videos/TD-04`.
**Context7 ID:** `/nestjs/docs.nestjs.com` (page `content/application/queues.md`).

### 1. Root connection with injected config

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});
```

Project adaptation: inject the `queue` namespace (`queueConfig.KEY`) like the other `forRootAsync` modules (phase 01 convention).

### 2. Register and inject a queue (producer — API)

```typescript
BullModule.registerQueue({ name: 'audio' });

@Injectable()
export class AudioService {
  constructor(@InjectQueue('audio') private audioQueue: Queue) {}
}
```

### 3. Consumer (worker only)

```typescript
@Processor('audio')
export class AudioConsumer extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    // return value is stored in the job
  }

  @OnWorkerEvent('active')
  onActive(job: Job) { /* ... */ }
}
```

Project adaptation: the processor class is registered only in the worker's module tree (TD-04), so the API process never instantiates a BullMQ `Worker`.

---

## @aws-sdk/client-s3

**Version line:** `^3.1166.0` (Context7 indexes up to `v3.996.0`; API surface used here is stable across 3.x).
**Decided in:** `phase-03-videos/TD-02`, `phase-03-videos/TD-03`.
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### 1. Client for an S3-compatible endpoint (MinIO)

```typescript
const client = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

**Checksum gotcha (from the SDK middleware source cached by Context7):** "the SDK only sets a default checksum algorithm (CRC32) if `requestChecksumCalculation` is `WHEN_SUPPORTED` … For `UploadPartCommand`, `requestChecksumRequired` is false, so setting `WHEN_REQUIRED` prevents the default CRC32 from being added." Without it, presigned `UploadPart` URLs carry `x-amz-checksum-*`/`x-amz-sdk-checksum-algorithm` that a browser `PUT` cannot satisfy. Both S3 clients of the project use `WHEN_REQUIRED`.

### 2. Multipart commands used

- `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`.
- `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` — presigned only (the API never sends part bodies).
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` — `PartNumber` starts at 1 and parts must be in ascending order.
- `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType`.
- `PutObjectCommand` (thumbnail buffer from the worker), `DeleteObjectCommand`.

### 3. `GetObjectCommand` response overrides (used when presigning)

`ResponseContentDisposition`, `ResponseContentType` — set on the presigned GET so the storage answers the download with `Content-Disposition: attachment; filename="…"`.

---

## @aws-sdk/s3-request-presigner

**Version line:** `^3.1166.0` (released together with `@aws-sdk/client-s3`; keep both on the same version).
**Decided in:** `phase-03-videos/TD-02` (part URLs), `phase-03-videos/TD-05` (worker source URL), `phase-03-videos/TD-08` (stream/download/thumbnail URLs).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: 3600 });
```

"You can get signed URL for other S3 operations too, like `PutObjectCommand`. `expiresIn` … if not set, it's default at `900`."

Project adaptation: URLs handed to clients are signed by a second `S3Client` whose `endpoint` is `S3_PUBLIC_ENDPOINT` (SigV4 signs the `host` header, so the URL must be signed for the host the client will call — TD-03 decision, IC-2).
