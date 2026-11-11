---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-11T13:26:09-04:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T14:01:56-04:00"
  docs/phases/phase-03-videos/context.md: "2026-11-11T14:04:28-04:00"
  docs/phases/phase-03-videos/validation.md: "2026-11-11T14:04:56-04:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-11T14:03:19-04:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of files up to 10 GiB straight to object storage (S3 multipart with presigned part URLs — no video byte crosses the API), automatic draft pre-registration, background processing in a dedicated FFmpeg worker fed by a BullMQ/Redis queue (duration, metadata and thumbnail), a unique short URL per video, and progressive streaming/download served by the storage through presigned redirects — with MinIO, Redis and the worker running in Docker Compose next to the API.

---

## Step Implementations

### SI-03.1 — Infrastructure: Compose Services, FFmpeg Image, Dependencies and Config Namespaces

**Description:** Add the object storage, queue broker and worker infrastructure to Docker Compose, install FFmpeg in the dev image, install the Phase 03 libraries and create the `storage`, `queue` and `video` config namespaces validated by Joi (per `phase-03-videos/TD-01`, `TD-03`, `TD-04`, `TD-10`).

**Technical actions:**

- Install production dependencies: `bullmq@^6.7.4`, `@nestjs/bullmq@^11.0.5` (revised from `^12.0.1` — ESM-only, see TD-01 Revisions), `ioredis@^5.11.1`, `@aws-sdk/client-s3@^3.1166.0`, `@aws-sdk/s3-request-presigner@^3.1166.0` (versions from `library-refs.md`)
- `Dockerfile.dev`: add `ffmpeg` to the `apt install` line (provides `ffmpeg` and `ffprobe`)
- `compose.yaml`:
  - `redis` — `redis:7.4.12-alpine`, command `redis-server --appendonly yes --maxmemory-policy noeviction`, healthcheck `redis-cli ping`, volume `redis-data`
  - `minio` — `cgr.dev/chainguard/minio@sha256:db3f583fa49121942168bd6383a773b2cde3384c9a99bf7193560b9a0f3a28fd`, command `server /data`, `MINIO_ROOT_USER=${S3_ACCESS_KEY}` / `MINIO_ROOT_PASSWORD=${S3_SECRET_KEY}`, port `9000:9000`, **network alias `minio.localhost`** (TD-03 / IC-2), volume `minio-data`
  - `minio-init` — one-shot `amazon/aws-cli:2.27.50` that waits for MinIO and creates `${S3_BUCKET}` if missing
  - `video-worker` — same build as `nestjs-api`, same bind mount, waits for `node_modules` and runs `npm run start:worker:dev`; `restart: unless-stopped`; depends on `db` (healthy), `redis` (healthy), `minio-init` (completed)
  - `nestjs-api` — additionally depends on `redis` (healthy) and `minio-init` (completed)
- Create `src/config/storage.config.ts` — `registerAs('storage')`: `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://minio.localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `streamtube-videos`)
- Create `src/config/queue.config.ts` — `registerAs('queue')`: `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`)
- Create `src/config/video.config.ts` — `registerAs('video')`: `VIDEO_MAX_SIZE_BYTES` (default `10737418240`), `VIDEO_UPLOAD_PART_SIZE_MB` (default `100`, exposed as `partSizeBytes`), `VIDEO_URL_TTL_SECONDS` (default `3600`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`), `VIDEO_PROCESSING_BACKOFF_MS` (default `5000`), `VIDEO_FFMPEG_TIMEOUT_MS` (default `300000`)
- Extend `src/config/env.validation.ts` (S3 credentials required; others with defaults; part size min 5 — S3 minimum part size) and register the three namespaces in `AppModule`'s `ConfigModule.forRoot({ load })`
- Update `.env.example` with all new keys and Compose-compatible defaults

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | S3 credentials are required; defaults for the new keys (10 GiB limit, 100 MiB part, `minio:9000` / `minio.localhost:9000`); part size below 5 MiB is rejected |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts `db`, `mailpit`, `redis`, `minio`, `minio-init` (exits 0), `nestjs-api` and `video-worker`
- The bucket `${S3_BUCKET}` exists after `minio-init` completes; `redis-cli ping` answers `PONG`
- `docker compose exec nestjs-api ffprobe -version` succeeds
- Booting the app without `S3_ACCESS_KEY` fails Joi validation

---

### SI-03.2 — Storage Module (S3 API over MinIO)

**Description:** Encapsulate every object-storage operation in a `StorageService` with two `S3Client`s: an internal one for service-to-service calls and a public one used only to sign client-facing URLs (per `phase-03-videos/TD-03`, IC-2). All other modules use this service — nobody instantiates `S3Client` directly.

**Technical actions:**

- Create `src/storage/storage.service.ts` — `StorageService` injecting `storageConfig`. Clients built with `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'` (`library-refs.md` checksum gotcha). Methods:
  - `createMultipartUpload(key, contentType): Promise<string>` (UploadId)
  - `presignUploadPart(key, uploadId, partNumber, expiresIn): Promise<string>` — public client
  - `completeMultipartUpload(key, uploadId, parts: { partNumber, etag }[]): Promise<void>`
  - `abortMultipartUpload(key, uploadId): Promise<void>`
  - `headObject(key): Promise<{ contentLength: number; contentType?: string } | null>` (`null` on `NotFound`)
  - `presignGetObject(key, { expiresIn, contentType?, contentDisposition?, audience: 'public' | 'internal' }): Promise<string>`
  - `putObject(key, body: Buffer, contentType): Promise<void>`
  - `deleteObject(key): Promise<void>`
- Create `src/storage/storage.module.ts` — provides and exports `StorageService`
- Storage errors are translated into a domain-agnostic `StorageOperationException` only where callers need to branch (e.g., `CompleteMultipartUpload` rejecting parts → `StorageUploadRejectedException`); other errors propagate

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO: multipart with 2 parts uploaded via **public** presigned URLs from inside the container (alias `minio.localhost`), completion, `headObject` size; invalid ETag → `StorageUploadRejectedException`; presigned GET answers `206` to a `Range` request and honours `ResponseContentDisposition`; `putObject`/`deleteObject`; `headObject` returns `null` for missing keys; abort removes the upload |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles and resolves `StorageService` with the config namespace |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A file uploaded in parts through presigned URLs signed for `S3_PUBLIC_ENDPOINT` is assembled by `completeMultipartUpload` and has the expected size
- A presigned GET URL supports `Range: bytes=0-99` → `206 Partial Content` with `Content-Range`
- No `S3Client` is created outside `src/storage/`

---

### SI-03.3 — Video Entity, Migration and Channel Lookup

**Description:** Persist videos in a `videos` table owned by a channel, generated by the TypeORM CLI, and add the channel lookup by user id needed by every owner operation (per `phase-03-videos/TD-07`, `TD-09`; DG-1).

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `Video` (`@Entity('videos')`) with the columns of the Data Model below; `VideoStatus` enum (`draft`, `processing`, `ready`, `failed`); `size_bytes` `bigint` with a number transformer; `upload_id` with `select: false`
- `Channel` gets the inverse side `@OneToMany(() => Video, (video) => video.channel) videos`
- Generate `src/database/migrations/<timestamp>-CreateVideos.ts` with `npm run migration:generate` (enum type, table, unique slug index, channel index, FK `ON DELETE CASCADE`)
- `ChannelsService.findByUserId(userId): Promise<Channel | null>`
- `src/test/create-test-data-source.ts` — `cleanAllTables()` deletes `videos` first (FK order)
- `src/database/migrations.integration-spec.ts` — include the new migration, the `videos` table and its enum type in the managed sets

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Defaults (`status = draft`), unique `slug`, FK to channel with cascade delete, `upload_id` hidden by default, `bigint` size round-trips as number above 2³² |
| `src/database/migrations.integration-spec.ts` | Integration | All 3 migrations apply on an empty schema and the last one reverts (videos table and enum removed) |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` returns the user's channel and `null` for unknown users |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with the `videos_status_enum` type; `migration:revert` removes both
- Deleting a channel deletes its videos
- `ChannelsService.findByUserId()` resolves the caller's channel from `JwtPayload.sub`

---

### SI-03.4 — Draft Pre-registration and Multipart Initiation (`POST /videos`)

**Description:** Create the `VideosModule` with the endpoint that pre-registers a video as `draft`, generates its unique slug and opens the multipart upload — the first step of the TD-02 handshake. Also registers the BullMQ root connection and overrides the inherited throttler for video routes (ICC-1).

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` with `queueConfig` (connection host/port), imported by `AppModule` (global infrastructure); `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`
- Create `src/videos/video-slug.util.ts` — `generateVideoSlug()` = `randomBytes(8).toString('base64url')` (11 chars)
- Create `src/videos/video-storage-keys.ts` — `originalKey(videoId)` = `videos/{id}/original`, `thumbnailKey(videoId)` = `videos/{id}/thumbnail.jpg`
- Create `src/videos/videos.constants.ts` — `ALLOWED_VIDEO_CONTENT_TYPES`, `MAX_PARTS_PER_SIGN_REQUEST = 100`, `TITLE_MAX_LENGTH = 100`
- Create `src/videos/videos.exceptions.ts` — `DomainException` subclasses from the Error Catalog
- Create `src/videos/dto/create-video.dto.ts` — `filename`, `content_type`, `size_bytes`, optional `title`
- Create `src/videos/videos.service.ts` — `createDraft(userId, dto)`: resolve channel (`CHANNEL_NOT_FOUND`), reject `size_bytes > maxSizeBytes` (`VIDEO_TOO_LARGE`), compute `part_count = ceil(size / partSize)`, `id = randomUUID()`, `createMultipartUpload(originalKey(id))`, insert the row retrying the slug on `23505` (max 5), **compensate** with `abortMultipartUpload` if the insert fails; title defaults to the filename without extension
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos') @Throttle({ default: { limit: 120, ttl: 60000 } })`; `POST /videos` → 201 (authenticated, `@ApiBearerAuth('access-token')`)
- Register `VideosModule` (imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`) in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-slug.util.spec.ts` | Unit | 11 URL-safe chars; no collisions in 10,000 draws |
| `src/videos/videos.service.spec.ts` | Unit | `createDraft`: too large → `VideoTooLargeException`; no channel → `ChannelNotFoundException`; part count math (exact multiple and remainder); title default from filename; slug retry on unique violation; abort compensation when insert fails |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO: draft row persisted with `status = draft`, `upload_id`, `storage_key = videos/{id}/original`; multipart upload exists in MinIO |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with its imports |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 201 shape; 10 GiB exactly → 201 with `part_count = 103`; 10 GiB + 1 byte → 422 `VIDEO_TOO_LARGE`; unsupported `content_type` / missing fields → 400; no token → 401 |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` returns 201 with the draft (`status: "draft"`, 11-char `slug`) and `upload: { part_size, part_count, max_parts_per_request }`
- The video row exists as `draft` immediately — before any byte is uploaded (pré-cadastro)
- A declared size of 10,737,418,240 bytes is accepted; one byte more is rejected with 422
- Two drafts never share a slug (unique index + retry)

---

### SI-03.5 — Upload Handshake: Sign Parts, Complete (enqueue) and Abort

**Description:** Finish the TD-02 handshake: presign part URLs, complete and verify the upload, move the video to `processing` and enqueue the processing job in the same transaction (per `TD-02`, `TD-09`, `TD-10`); abort releases the multipart upload and removes the draft.

**Technical actions:**

- DTOs: `src/videos/dto/sign-upload-parts.dto.ts` (`part_numbers: int[]`, 1–100 unique items, each ≥ 1), `src/videos/dto/complete-upload.dto.ts` (`parts: { part_number, etag }[]`, nested validation)
- `VideosService`:
  - `findOwnedVideo(userId, slug)` — joins channel; unknown slug **or** other owner → `VIDEO_NOT_FOUND` (does not leak existence)
  - `signUploadParts(userId, slug, partNumbers)` — requires `draft` (`VIDEO_NOT_IN_DRAFT`); each number ≤ `part_count` (`INVALID_PART_NUMBER`); returns presigned URLs + `expires_in`
  - `completeUpload(userId, slug, parts)` — requires `draft`; parts must be exactly `1..part_count` (`INVALID_UPLOAD_PARTS`); `completeMultipartUpload` (`StorageUploadRejectedException` → `UPLOAD_INCOMPLETE`); `headObject` size must equal `size_bytes` — otherwise delete the object, mark the video `failed` (`processing_error`) and throw `UPLOAD_SIZE_MISMATCH`; then in a transaction: conditional update `draft → processing` (clears `upload_id`) and `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId, attempts, backoff: { type: 'exponential', delay }, removeOnComplete/removeOnFail by age })`
  - `abortUpload(userId, slug)` — requires `draft`; `abortMultipartUpload` then delete the row
- Controller: `POST /videos/:slug/upload-parts` (200), `POST /videos/:slug/complete-upload` (200), `DELETE /videos/:slug/upload` (204)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Ownership/not-found; status guards; part-number bounds; parts set validation; size mismatch path marks `failed` and deletes the object; enqueue options (`jobId`, attempts, backoff); transaction rollback when `queue.add` throws |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO + Redis: full handshake with 2 parts (5 MiB part size override) → `processing`, `upload_id` cleared, job `videoId` found with `queue.getJob(videoId)`; abort deletes row and multipart upload |
| `test/videos.e2e-spec.ts` | E2E | Sign/complete/abort status codes and error codes; other user's slug → 404; invalid bodies → 400 |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- A client can upload every part directly to the storage using only URLs returned by the API, then complete the upload; the API never receives the file bytes
- After completion the video is `processing` and exactly one job with id = video id is in the queue
- Completing with missing parts, wrong ETags, or a size different from the declared one is rejected (400/422) and never enqueues
- Aborting a draft removes the row and the pending multipart upload

---

### SI-03.6 — Video Processing: FFprobe Metadata, Thumbnail and Failure Handling

**Description:** Implement the worker-side processing (per `TD-05`, `TD-06`, `TD-09`): probe the source through a presigned internal URL, store duration and metadata, extract the thumbnail frame, mark `ready`; mark `failed` on unrecoverable input or after the last retry. Idempotent: only videos in `processing` are touched.

**Technical actions:**

- Create `src/videos/processing/media-tools.service.ts` — `MediaToolsService.probe(url)` spawns `ffprobe -v error -print_format json -show_format -show_streams <url>` and maps it to `{ durationSeconds, metadata }` (`metadata`: container format, bit rate, width, height, video codec, frame rate, audio codec); `extractFrame(url, offsetSeconds, width)` spawns `ffmpeg -ss <offset> -i <url> -frames:v 1 -vf scale=<width>:-2 -f image2 -c:v mjpeg pipe:1` and returns the JPEG buffer; both with `VIDEO_FFMPEG_TIMEOUT_MS`; non-zero exit → `MediaToolException` (with stderr tail)
- Pure helper `thumbnailOffsetSeconds(duration)` = `min(duration × 0.1, 10)`, `0` when unknown/< 1 s
- Create `src/videos/processing/video-processing.service.ts` — `processVideo(videoId): Promise<'processed' | 'skipped'>`: load video; not found or status ≠ `processing` → `skipped`; `headObject` missing → `SourceObjectMissingException`; probe; no video stream → `InvalidVideoMediaException`; extract + `putObject(thumbnailKey)`; conditional update `processing → ready` with `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`. `markFailed(videoId, reason)` — conditional update `processing → failed` with `processing_error` (truncated)
- Create `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`; `process(job)` delegates to the service and rethrows `InvalidVideoMediaException`/`SourceObjectMissingException` as `UnrecoverableError`; `@OnWorkerEvent('failed')` calls `markFailed` when the error is unrecoverable or `attemptsMade >= opts.attempts` (catch-and-log only here — background context)
- Create `src/videos/processing/video-processing.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.registerQueue`; providers: processor, `VideoProcessingService`, `MediaToolsService`
- `src/test/test-media.ts` — generates small test videos with `ffmpeg -f lavfi` (no binary fixtures)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/media-tools.service.spec.ts` | Unit | ffprobe JSON → duration/metadata mapping (fraction frame rates, missing fields, no video stream flag); `thumbnailOffsetSeconds` boundaries |
| `src/videos/processing/media-tools.service.integration-spec.ts` | Integration | Real FFmpeg over a presigned MinIO URL: probe of a generated 3 s 320×240 video (duration ≈ 3 s, codec, size); JPEG frame extracted (`FFD8` magic); garbage input → `MediaToolException` |
| `src/videos/processing/video-processing.service.spec.ts` | Unit | Branches: skipped (missing / not processing), missing object, invalid media, success update payload, `markFailed` truncation |
| `src/videos/processing/video-processing.service.integration-spec.ts` | Integration | Real DB + MinIO + FFmpeg: `processing → ready` with duration, metadata and thumbnail object stored; non-video upload → `InvalidVideoMediaException`, `markFailed` → `failed`; second run is `skipped` (idempotent) |
| `src/videos/processing/video-processing.processor.spec.ts` | Unit | Unrecoverable mapping; `failed` event marks failed only on final attempt or unrecoverable error |

**Dependencies:** SI-03.3, SI-03.2 (SI-03.5 for the job contract)

**Acceptance criteria:**

- A processed video has `status = ready`, `duration_seconds`, `metadata` (format, codecs, resolution) and a JPEG thumbnail at `videos/{id}/thumbnail.jpg`
- A non-video file ends as `failed` without retries; a transient error is retried up to 3 times before `failed`
- Re-delivering the job for a `ready`/`failed` video changes nothing

---

### SI-03.7 — Worker Entrypoint and Container

**Description:** Run the processor in its own process/container (per `TD-04`): a Nest application context without HTTP, sharing config, TypeORM and queue setup with the API.

**Technical actions:**

- Create `src/database/typeorm-options.ts` — `typeOrmOptionsFactory(dbConfig)` shared by `AppModule` and `WorkerModule` (removes duplication of the inline factory)
- Create `src/worker.module.ts` — `ConfigModule.forRoot` (same `load` + Joi schema), `TypeOrmModule.forRootAsync(typeOrmOptionsFactory)`, `QueueModule`, `VideoProcessingModule`
- Create `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()`, log "Video worker ready"
- `package.json` scripts: `start:worker` (`node dist/worker`) and `start:worker:dev` (`node --watch -r ts-node/register src/worker.ts`, `TS_NODE_TRANSPILE_ONLY=true`)
- `compose.yaml` `video-worker` command uses `start:worker:dev`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker.module.spec.ts` | Unit | `WorkerModule` compiles; `VideoProcessingProcessor` is registered; no HTTP controllers in the worker module tree |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `docker compose ps` shows `video-worker` running and its log shows "Video worker ready"
- The API process does not instantiate a BullMQ worker (processor only exists in `WorkerModule`)
- A job enqueued by the API is processed by the `video-worker` container (verified end-to-end in SI-03.8)

---

### SI-03.8 — Read Endpoints: Video, Owner Status, Stream, Download and Thumbnail

**Description:** Expose the unique-URL read surface (per `TD-07`, `TD-08`, `TD-11`): public metadata and `302` redirects to presigned storage URLs for ready videos; authenticated status for the owner.

**Technical actions:**

- `VideosService`:
  - `getPublicVideo(slug)` — only `ready` (else `VIDEO_NOT_FOUND`); returns metadata + channel (`nickname`, `name`) + API URLs `stream_url`, `download_url`, `thumbnail_url` built from `app.url`
  - `getOwnerStatus(userId, slug)` — any status, owner only
  - `getStreamUrl(slug)` / `getDownloadUrl(slug)` / `getThumbnailUrl(slug)` — `ready` only; public presigned GET with TTL `VIDEO_URL_TTL_SECONDS`; stream sets `ResponseContentType`, download sets `ResponseContentDisposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`
- Controller (`@Public()` on the four public routes, `@Redirect()` with dynamic URL → 302): `GET /videos/:slug`, `GET /videos/:slug/status` (authenticated), `GET /videos/:slug/stream`, `GET /videos/:slug/download`, `GET /videos/:slug/thumbnail`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Ready-only rule; owner-only status; download disposition with non-ASCII filename; URL composition |
| `test/videos.e2e-spec.ts` | E2E | **Full flow with the real worker container:** generated ~11 MB video uploaded in 3 parts through presigned URLs → complete → poll `/status` until `ready` → `GET /videos/:slug` (anonymous) → `/stream` 302 → `Range` request on `Location` → `206` + `Content-Range` → `/download` 302 → `Content-Disposition: attachment` → `/thumbnail` 302 → `image/jpeg`. Non-video upload → `failed` with `processing_error`. Draft/processing → public routes 404; `/status` 401 without token, 404 for another user |

**Dependencies:** SI-03.5, SI-03.7

**Acceptance criteria:**

- Anonymous `GET /videos/{slug}` returns a ready video's metadata, duration and URLs; non-ready or unknown slugs return 404
- `GET /videos/{slug}/stream` redirects to a URL that answers `206 Partial Content` to range requests (playback without full download)
- `GET /videos/{slug}/download` redirects to a URL that answers with `Content-Disposition: attachment`
- The owner sees `draft`, `processing`, `ready` or `failed` (+ `processing_error`) at `/status`

---

### SI-03.9 — OpenAPI Contract and AI Documentation

**Description:** Keep the exported contract and the AI foundation coherent with the code (per `openapi-docs-nestjs/TD-02`; phase brief requirement for `CLAUDE.md`).

**Technical actions:**

- Regenerate `nestjs-project/openapi.json` with `npm run openapi:export` (videos paths + DTO schemas)
- Extend `src/openapi-export.integration-spec.ts` to assert the `/videos` paths and the `access-token` security on owner routes
- Update root `CLAUDE.md` (architecture: queue = BullMQ/Redis, MinIO, worker) and `nestjs-project/CLAUDE.md` (services, ports, commands, worker, storage endpoints, videos section with endpoints/statuses, test notes)
- Add video requests to `nestjs-project/api.http`
- Update `docs/diagrams/software-arch.mermaid` queue container from `TBD` to `BullMQ (Redis)`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` | Integration | Exported spec contains the 8 video operations; owner routes declare bearer security, public routes do not |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `openapi.json` documents every video endpoint with success and error responses
- Every file, command and endpoint cited in `CLAUDE.md` exists in the code

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the service (`randomUUID()`) before the insert so the storage key can be derived from it |
| channel_id | uuid | FK → channels.id, `ON DELETE CASCADE`, not null, indexed | Owner (per TD-11 the owner is the channel's user) |
| slug | varchar(11) | unique, not null | Unique URL identifier (TD-07) |
| title | varchar(100) | not null | Defaults to the filename without extension |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` | Lifecycle (TD-09) |
| original_filename | varchar(255) | not null | Used for the download `Content-Disposition` |
| content_type | varchar(100) | not null | One of the allowlist (TD-10) |
| size_bytes | bigint | not null | Declared size, verified after completion; number transformer |
| storage_key | varchar(255) | not null | `videos/{id}/original` (TD-03) |
| upload_id | varchar(255) | nullable, `select: false` | S3 multipart `UploadId` while `draft`; cleared on completion |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg` once ready |
| duration_seconds | double precision | nullable | From ffprobe `format.duration` |
| metadata | jsonb | nullable | `{ format_name, bit_rate, width, height, video_codec, frame_rate, audio_codec }` |
| processing_error | text | nullable | Reason when `failed` |
| processed_at | timestamp | nullable | When the worker finished |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, `channel_id`); Channel → Video (one-to-many, inverse side)
**Indexes:** unique `(slug)`; `(channel_id)`

#### Object storage layout (TD-03)

| Key | Written by | Read by |
|-----|------------|---------|
| `videos/{videoId}/original` | Client (multipart parts via presigned URLs), assembled by `CompleteMultipartUpload` | Worker (presigned internal GET), clients (stream/download redirects) |
| `videos/{videoId}/thumbnail.jpg` | Worker (`PutObject`) | Clients (thumbnail redirect) |

---

### API Contracts

All video routes: `@Throttle({ default: { limit: 120, ttl: 60000 } })` (ICC-1). Error bodies follow the inherited `{ statusCode, error, message }` envelope.

#### POST /videos (SI-03.4)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- filename: string, required — 1–255 chars
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- size_bytes: integer, required — ≥ 1 (≤ 10,737,418,240 enforced by the service → 422)
- title: string, optional — 1–100 chars (default: filename without extension)

**Response 201:**
- id: string (uuid)
- slug: string (11 chars)
- title: string
- status: `"draft"`
- size_bytes: number
- content_type: string
- created_at: string (ISO-8601)
- upload: `{ part_size: number, part_count: number, max_parts_per_request: 100 }`

**Error responses:**
- 400 VALIDATION_ERROR: invalid body
- 401: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel
- 422 VIDEO_TOO_LARGE: `size_bytes` above the limit

---

#### POST /videos/{slug}/upload-parts (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1–100 unique items, each ≥ 1

**Response 200:**
- parts: `{ part_number: number, url: string }[]` — presigned `PUT` URLs (client sends the raw part bytes and keeps the `ETag` response header)
- expires_in: number (seconds)

**Error responses:**
- 400 VALIDATION_ERROR / 400 INVALID_PART_NUMBER (number above `part_count`)
- 401
- 404 VIDEO_NOT_FOUND: unknown slug or not the owner
- 409 VIDEO_NOT_IN_DRAFT: upload already completed

---

#### POST /videos/{slug}/complete-upload (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- parts: `{ part_number: integer ≥ 1, etag: string }[]`, required — must be exactly `1..part_count`

**Response 200:** the video (`id`, `slug`, `title`, `status: "processing"`, `size_bytes`, `content_type`, `created_at`)

**Error responses:**
- 400 VALIDATION_ERROR / 400 INVALID_UPLOAD_PARTS
- 401
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_IN_DRAFT
- 422 UPLOAD_INCOMPLETE: storage rejected the part list (missing part, wrong ETag, too-small part)
- 422 UPLOAD_SIZE_MISMATCH: stored object size differs from `size_bytes` (video marked `failed`)

---

#### DELETE /videos/{slug}/upload (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 204:** No content (multipart upload aborted, draft removed).

**Error responses:**
- 401
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_IN_DRAFT

---

#### GET /videos/{slug}/status (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- slug, title, status (`draft` | `processing` | `ready` | `failed`)
- duration_seconds: number | null
- processing_error: string | null
- created_at, updated_at, processed_at (ISO-8601 | null)

**Error responses:**
- 401
- 404 VIDEO_NOT_FOUND: unknown slug or not the owner

---

#### GET /videos/{slug} (SI-03.8)

**Response 200** (public, ready videos only):
- id, slug, title, status: `"ready"`, duration_seconds, size_bytes, content_type
- metadata: `{ format_name, bit_rate, width, height, video_codec, frame_rate, audio_codec }`
- channel: `{ nickname, name }`
- stream_url, download_url, thumbnail_url: string (API URLs under `APP_URL`)
- created_at

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown slug or video not `ready`

---

#### GET /videos/{slug}/stream · GET /videos/{slug}/download · GET /videos/{slug}/thumbnail (SI-03.8)

**Response 302:** `Location` = presigned storage URL valid for `VIDEO_URL_TTL_SECONDS`.
- stream: `ResponseContentType = content_type`; the storage answers `Range` with `206 Partial Content`, `Accept-Ranges: bytes`
- download: `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`
- thumbnail: `image/jpeg`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown slug or video not `ready`

---

#### Validation Rules — videos

- `filename`: string, 1–255
- `content_type`: allowlist (`ALLOWED_VIDEO_CONTENT_TYPES`)
- `size_bytes`: integer ≥ 1; service limit `VIDEO_MAX_SIZE_BYTES` (10 GiB)
- `title`: optional string, 1–100
- `part_numbers`: array of 1–100 unique integers ≥ 1
- `parts[]`: `part_number` integer ≥ 1, `etag` non-empty string; array 1–10,000 items

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos | ✗ | ✓ | — | Creates a draft in the caller's channel |
| POST /videos/{slug}/upload-parts | ✗ | ✗ (404) | ✓ | Draft only |
| POST /videos/{slug}/complete-upload | ✗ | ✗ (404) | ✓ | Draft only |
| DELETE /videos/{slug}/upload | ✗ | ✗ (404) | ✓ | Draft only |
| GET /videos/{slug}/status | ✗ | ✗ (404) | ✓ | Any status |
| GET /videos/{slug} | ✓ | ✓ | ✓ | `ready` only (TD-11) |
| GET /videos/{slug}/stream | ✓ | ✓ | ✓ | `ready` only, 302 |
| GET /videos/{slug}/download | ✓ | ✓ | ✓ | `ready` only, 302 |
| GET /videos/{slug}/thumbnail | ✓ | ✓ | ✓ | `ready` only, 302 |

---

### Error Catalog

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown slug; owner route called by another user; public route on a non-`ready` video |
| CHANNEL_NOT_FOUND | 404 | Channel not found for the current user | `POST /videos` by a user without channel |
| VIDEO_TOO_LARGE | 422 | Video exceeds the maximum size of 10737418240 bytes | `size_bytes` > `VIDEO_MAX_SIZE_BYTES` |
| VIDEO_NOT_IN_DRAFT | 409 | Video upload is not in progress | Sign/complete/abort on a non-`draft` video |
| INVALID_PART_NUMBER | 400 | Part number exceeds the number of parts of this upload | `part_numbers` item > `part_count` |
| INVALID_UPLOAD_PARTS | 400 | Parts must be exactly 1..N without gaps or duplicates | `complete-upload` with an incomplete/duplicated list |
| UPLOAD_INCOMPLETE | 422 | Storage rejected the uploaded parts | `CompleteMultipartUpload` error (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | `HeadObject.ContentLength ≠ size_bytes` |
| VALIDATION_ERROR | 400 | _(array of field errors)_ | DTO validation (inherited) |

Worker-side (not HTTP): `InvalidVideoMediaException` (no video stream / ffprobe failure on the content) and `SourceObjectMissingException` → `UnrecoverableError` → video `failed`; `MediaToolException` on timeouts/transient failures → retried.

---

### Events/Messages

#### video-processing / `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (deduplication), `attempts = VIDEO_PROCESSING_ATTEMPTS (3)`, `backoff = { type: "exponential", delay: VIDEO_PROCESSING_BACKOFF_MS (5000) }`, `removeOnComplete = { age: 86400 }`, `removeOnFail = { age: 604800 }`
**Producer:** `VideosService.completeUpload()` in the API, inside the transaction that sets `status = processing` (per `phase-03-videos/TD-01`, `TD-09`)
**Consumer:** `VideoProcessingProcessor` in the `video-worker` container (per `phase-03-videos/TD-04`)
**Trigger:** multipart upload completed and verified (`HeadObject` size = declared size)
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-09`) — the consumer is idempotent: it acts only on videos in `processing`, and the final state transitions are conditional updates (`WHERE status = 'processing'`)
**Outcome (DB, not a message):** `processing → ready` (duration, metadata, thumbnail) or `processing → failed` (`processing_error`) after an unrecoverable error or the last attempt

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
└── SI-03.3

SI-03.2 + SI-03.3
└── SI-03.4
    └── SI-03.5

SI-03.2 + SI-03.3 (+ job contract from SI-03.5)
└── SI-03.6
    └── SI-03.7

SI-03.5 + SI-03.7
└── SI-03.8
    └── SI-03.9
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9

## Deliverables

- [ ] MinIO (object storage), Redis (queue broker), bucket bootstrap and `video-worker` running via `docker compose up -d`
- [ ] FFmpeg available in the dev image (API and worker)
- [ ] `videos` table created by a generated migration, linked to `channels` (cascade)
- [ ] Draft pre-registration with unique 11-char slug on `POST /videos`
- [ ] 10 GiB upload via S3 multipart with presigned part URLs — no video byte through the API
- [ ] Upload completion verifies size and enqueues `process-video` (job id = video id)
- [ ] Worker extracts duration/metadata (ffprobe) and a JPEG thumbnail, marks `ready`; unrecoverable/final failures mark `failed`
- [ ] Public read of ready videos by unique URL; streaming with `206 Partial Content` and download with `attachment` via presigned redirects
- [ ] Owner status endpoint showing `draft → processing → ready | failed`
- [ ] `openapi.json` regenerated with the video endpoints
- [ ] `CLAUDE.md` (root and `nestjs-project/`) updated with the videos section
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
