---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-11
scope_description: "Backend foundation for video upload and processing: queue technology, 10GB upload protocol, object storage usage, video worker runtime, FFmpeg integration, thumbnail, unique URL, streaming/download delivery, status lifecycle and upload limits."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module (API), the video worker entrypoint, the `videos` table migration and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document: the challenge scope for this phase is backend-only ("a interface de vídeo não faz parte do escopo desta fase"). The upload handshake (TD-02) and the streaming URLs (TD-08) are described with their frontend impact so a future UI phase can consume them, but no frontend code is planned here.

Stack constraints read before researching (installed versions in `nestjs-project/package-lock.json`): `@nestjs/core 11.1.16`, `typeorm 0.3.28`, `@nestjs/config ^4.0.3`, `joi ^18.1.2`, Node image `node:25.6.0-slim` (`Dockerfile.dev`). Object storage is **not** an open choice: the project plan and `docs/diagrams/software-arch.mermaid` fix it as "S3 or MinIO" — MinIO locally, S3 in production. The open stack choice is the queue (`Message Queue (TBD)` in the diagram and in `CLAUDE.md`).

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as `TBD`. The API must publish a "process this video" job after the upload completes and a separate worker must consume it. Processing a long video can take minutes, may fail transiently (storage hiccup, worker restart) and must be retried without user action. The choice adds one container to `compose.yaml`, one config namespace, and defines the producer/consumer API used on both sides.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Jobs are stored in Redis; producers call `queue.add(name, data, opts)`, consumers extend `WorkerHost` with `@Processor('queue')`. Official NestJS integration (`@nestjs/bullmq`, peer range `^10 || ^11 || ^12`, compatible with the installed `@nestjs/core 11.1.16`).
- **Pros:** first-class NestJS module (`BullModule.forRootAsync`, `registerQueue`, `@InjectQueue`, `@OnWorkerEvent`); built-in retries with exponential backoff, `attempts`, `UnrecoverableError` for permanent failures, custom `jobId` for deduplication, stalled-job recovery, concurrency per worker; Redis is a small container; the testing guide (`testing-guide-nestjs-project/references/external-systems.md`) already sketches BullMQ as the expected setup.
- **Cons:** one more stateful service (Redis) to operate; Redis must run with `maxmemory-policy noeviction` (BullMQ requirement) and with persistence if jobs must survive a broker restart; job state lives outside PostgreSQL (dual write API → DB + Redis).

### Option B: RabbitMQ (AMQP, `@nestjs/microservices` or `amqplib`)
- A dedicated message broker; the API publishes to an exchange/queue and the worker consumes with manual ack. Retries are built with dead-letter exchanges + TTL queues.
- **Pros:** mature broker, strong delivery guarantees, routing flexibility, management UI, language-agnostic consumers (a future non-Node worker could consume directly).
- **Cons:** heavier container; retry with backoff, delayed retries and "job state" (progress, attempts, failure reason) must be built by hand on top of DLX/TTL; NestJS microservices transport is request/event oriented, not job oriented; more moving parts for a single job type.

### Option C: PostgreSQL-backed queue (`pg-boss`)
- Jobs stored in PostgreSQL tables using `SELECT … FOR UPDATE SKIP LOCKED`. No new container.
- **Pros:** zero new infrastructure; job insert can share the same transaction as the video status update (no dual write); retries/backoff supported.
- **Cons:** no official NestJS module (manual lifecycle wiring); polling load on the primary database, which also serves the API; less adoption/documentation than BullMQ; the architecture diagram models the queue as its own container.

**Recommendation:** Option A (BullMQ + Redis) — native NestJS integration and built-in retry/backoff/deduplication cover exactly the "process one heavy job reliably" need of this phase with the least custom code; the dual-write risk is handled by an idempotent consumer (see TD-09).

**Decision:** _[pending]_

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must not "hold" the API: no API worker thread, memory or disk should be occupied for the duration of the transfer, and a dropped connection should not force restarting from byte zero. The protocol is a contract between backend (endpoints, storage calls) and the future frontend (how the browser sends the bytes). Hard limits from the S3 API that the protocol must respect: a single `PutObject` accepts at most **5 GiB**; multipart upload accepts up to **10,000 parts**, each **5 MiB–5 GiB** (last part may be smaller), object up to 5 TiB.

**Options:**

### Option A: Stream through the API (`multipart/form-data` piped to storage)
- The browser POSTs the file to the API; the API pipes the request stream (e.g., busboy) into `@aws-sdk/lib-storage` `Upload` to S3/MinIO.
- **Pros:** single request for the client; API sees every byte (can validate on the fly).
- **Cons:** every byte of every upload crosses the API (bandwidth + an open connection per upload for minutes/hours); a broken connection restarts the whole 10GB; proxies/timeouts on the API path become a bottleneck — exactly the "passar o arquivo pela API" anti-pattern the phase must avoid.

### Option B: tus resumable protocol (`@tus/server` mounted in the API)
- Open protocol for resumable uploads; the client sends chunks with `PATCH` + `Upload-Offset`; the tus server (inside the API process) writes to S3 via `@tus/s3-store`.
- **Pros:** resumable by design, mature JS client (`tus-js-client`/Uppy).
- **Cons:** bytes still flow through the API process (same bandwidth problem as A, only chunked); one more protocol + library to maintain; the S3 store keeps per-upload state.

### Option C: S3 multipart upload with presigned part URLs (direct-to-storage)
- The API creates the video draft and calls `CreateMultipartUpload`; it returns the part size/count; the client asks the API for presigned `UploadPart` URLs (in batches) and `PUT`s each part **directly to the object storage**; finally the client sends the list of `{partNumber, ETag}` and the API calls `CompleteMultipartUpload`, verifies the object (`HeadObject`) and enqueues processing.
- **Pros:** zero video bytes through the API — the API only handles a few small JSON calls per upload; parts upload in parallel and failed parts are retried individually (resumable at part granularity; URLs can be re-signed); works identically on MinIO and AWS S3; supports the 10GB target with large margin (10,000 parts).
- **Cons:** more steps in the handshake (init → sign parts → complete); the browser needs CORS on the storage and must read the `ETag` response header; orphaned multipart uploads must be aborted (explicit abort endpoint + bucket lifecycle rule in production).

### Option D: Single presigned `PUT`
- One presigned URL for the whole object.
- **Pros:** simplest client code; bytes go direct to storage.
- **Cons:** S3 caps a single PUT at 5 GiB — cannot meet 10GB; no resume.

**Recommendation:** Option C (S3 multipart with presigned part URLs) — the only option that both keeps every video byte off the API and meets the 10GB target within S3 limits, with part-level retry; the handshake cost is a few small JSON requests.

**Decision:** _[pending]_

---

## TD-03: Object Storage Usage — Client SDK, Bucket/Key Layout and URL Signing

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage product is fixed (S3-compatible: MinIO locally, S3 in production). What must be decided is how the code talks to it and how objects are organized, because the same layout is used by the API (upload/sign/stream), the worker (read original, write thumbnail) and the Compose bootstrap (bucket creation).

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), one private bucket, key prefix per video
- Keys: `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg` in a single private bucket (`S3_BUCKET`). All client access goes through short-lived presigned URLs. MinIO is addressed with `forcePathStyle: true` and a custom `endpoint`.
- **Pros:** the SDK is the reference S3 client — same code against MinIO and S3; presigner supports `UploadPart` and `GetObject` (with `ResponseContentDisposition` for downloads); one bucket = one CORS/lifecycle policy; deleting a video = deleting one prefix.
- **Cons:** AWS SDK is large (modular v3 keeps it to the S3 client); keys are opaque to humans browsing the bucket.

### Option B: MinIO JS SDK (`minio`)
- MinIO's own client (`presignedPutObject`, `presignedGetObject`).
- **Pros:** simpler API surface.
- **Cons:** no first-class presigned `UploadPart` for multipart driven by the client; ties code to the local tool while production is S3; less used against AWS.

### Option C: Two buckets (`videos`, `thumbnails`), thumbnails public-read
- Thumbnails served by a public bucket URL without signing.
- **Pros:** cacheable stable thumbnail URLs.
- **Cons:** two bucket policies/CORS configs; a public bucket is a security decision this phase does not need (Phase 04 handles visibility); thumbnails of unpublished videos become guessable.

**Recommendation:** Option A — AWS SDK v3 with one private bucket and per-video key prefixes, so local and production use exactly the same code path and every access stays behind short-lived signatures.

**Decision:** _[pending]_

---

## TD-04: Video Worker Runtime

**Scope:** Repo-wide

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The diagram defines `Video Worker (FFmpeg)` as its own container. It needs FFmpeg binaries, access to DB (status update), storage (read original / write thumbnail) and the queue. Where its code lives and how it is started affects `compose.yaml`, the Dockerfile, npm scripts and how much code is shared with the API (entities, config, storage client).

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and container
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); `WorkerModule` imports config, TypeORM and the video-processing module with the BullMQ processor. Compose adds a `video-worker` service built from the same Dockerfile (which installs `ffmpeg`), running only that entrypoint.
- **Pros:** reuses entities, config namespaces (Joi validation), storage service and conventions; one `package.json`, one test suite, one lint/tsc pass; scales independently (separate container); API process never runs FFmpeg.
- **Cons:** API and worker share one dependency tree (FFmpeg present in the dev image of both); worker deploys with the API code version (acceptable — same repo/version).

### Option B: Separate subproject (`video-worker/`) with its own `package.json`
- Standalone Node service.
- **Pros:** fully independent deploy and dependency tree.
- **Cons:** duplicates entity/config/storage code or requires a shared package (monorepo tooling not present in the repo); doubles DoD surface (tests/lint/tsc in two places).

### Option C: Processor inside the API process
- Register the BullMQ processor in the API module.
- **Pros:** no new container.
- **Cons:** CPU-heavy FFmpeg work competes with HTTP requests — contradicts "sem impacto na performance" and the diagram's separate worker container.

**Recommendation:** Option A — the worker is a separate container (as the diagram requires) without duplicating the domain code; it is the lowest-cost way to keep FFmpeg out of the API process.

**Decision:** _[pending]_

---

## TD-05: FFmpeg Integration and Source Access in the Worker

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Duration and metadata come from `ffprobe`; the thumbnail from `ffmpeg`. Two sub-choices: how Node invokes the binaries, and how the binaries read a source that can be 10GB.

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- Fluent JS API over the binaries.
- **Pros:** convenient API, `ffprobe()` helper returns parsed JSON.
- **Cons:** the npm package is marked **deprecated** ("Package no longer supported", checked with `npm view fluent-ffmpeg deprecated` on 2026-11-11) and the repository was archived — adding a deprecated dependency to a new phase is a liability.

### Option B: Spawn `ffprobe`/`ffmpeg` directly (`node:child_process`) reading the source through a presigned HTTP URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` returns JSON; the thumbnail is `ffmpeg -ss <t> -i <url> -frames:v 1 -f image2 -c:v mjpeg pipe:1`. The URL is a short-lived presigned `GetObject` URL signed for the **internal** storage endpoint. FFmpeg's HTTP input uses range requests, so it only fetches the container header/index and the bytes around the seek point.
- **Pros:** no wrapper dependency; full control of arguments/timeouts; no local copy of a 10GB file (no disk sizing problem in the worker); stdout piping gives the JPEG as a buffer to upload.
- **Cons:** argument building and output parsing are our code (small, unit-testable); for files whose index (`moov` atom) is at the end, ffprobe performs an extra range read (still far less than a full download).

### Option C: Download the original to a temp file, then run FFmpeg locally
- `GetObject` stream → temp file → ffprobe/ffmpeg.
- **Pros:** FFmpeg reads a local file (most robust seeking).
- **Cons:** worker needs disk ≥ largest video (10GB+) and spends time copying bytes it does not read.

**Recommendation:** Option B — spawning the binaries avoids a deprecated wrapper, and reading through a presigned URL lets the worker handle 10GB sources without local disk.

**Decision:** _[pending]_

---

## TD-06: Thumbnail Generation Strategy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Which frame becomes the thumbnail and in which format/size. Custom thumbnails are Phase 04 (`thumbnail customizada`), so this is only the automatic one.

**Options:**

### Option A: Fixed offset (e.g., second 1)
- **Pros:** trivial, deterministic.
- **Cons:** the first second is often black/fade-in; breaks for clips shorter than the offset.

### Option B: Proportional offset — 10% of the duration (capped), JPEG, 1280px wide
- Offset = `min(duration × 0.1, 10s)`; falls back to `0` when duration is unknown or < 1s. Output a single JPEG scaled to width 1280 keeping aspect ratio (`scale=1280:-2`), uploaded to `videos/{id}/thumbnail.jpg`.
- **Pros:** avoids intro black frames in most videos, still deterministic and testable, cheap (one seek + one frame thanks to input seeking `-ss` before `-i`).
- **Cons:** may still land on a dull frame.

### Option C: FFmpeg `thumbnail` filter (scene analysis over N frames)
- **Pros:** picks a "representative" frame.
- **Cons:** decodes many frames (slow on long/large videos), less deterministic for tests.

**Recommendation:** Option B — deterministic and cheap, and avoids the common black first frame; scene analysis is not worth decoding many frames of a 10GB file.

**Decision:** _[pending]_

---

## TD-07: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier used in URLs (`/videos/{slug}`), which the frontend will route on. It must never collide and should not leak information.

**Options:**

### Option A: Use the UUID primary key in URLs
- **Pros:** already unique; nothing to generate.
- **Cons:** 36-char URLs; couples the public URL to the internal PK.

### Option B: Random short ID — 11 base64url chars from 8 random bytes (`crypto.randomBytes`), unique index + retry on collision
- 64 bits of entropy (same length class as YouTube IDs). A `UNIQUE` constraint on `videos.slug` guarantees no conflict; on a `23505` violation the service regenerates (bounded retries).
- **Pros:** short, URL-safe, non-sequential (not enumerable), independent of title edits (Phase 04 edits titles), no extra dependency (`node:crypto`).
- **Cons:** not human-readable.

### Option C: Title-based slug + suffix
- **Pros:** readable/SEO-friendly.
- **Cons:** the title is editable in Phase 04 (URL would change or drift), needs transliteration rules, leaks content of unlisted videos.

**Recommendation:** Option B — short, non-enumerable and stable across title edits; uniqueness is enforced by the database, not by probability alone.

**Decision:** _[pending]_

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo) · Download do vídeo pelo usuário

**Context:** The player must start without downloading the whole file and be able to seek; the user must be able to download the original. The diagram has `Frontend → Object Storage: Streams`, i.e., bytes are expected to come from storage, not from the API.

**Options:**

### Option A: API proxies the bytes with HTTP Range (`206 Partial Content`)
- `GET /videos/{slug}/stream` reads the `Range` header and pipes `GetObject({ Range })` back with `206`.
- **Pros:** single origin; API can meter/authorize every byte.
- **Cons:** every watched byte crosses the API (the same bottleneck TD-02 avoids for uploads); API must implement Range parsing/edge cases.

### Option B: API authorizes and redirects (`302`) to a short-lived presigned storage URL
- `GET /videos/{slug}/stream` → `302 Location: <presigned GetObject, inline, Content-Type>`; `GET /videos/{slug}/download` → `302` with `ResponseContentDisposition: attachment; filename="…"`. The storage serves `Range` requests natively with `206 Partial Content` and `Accept-Ranges: bytes`, so `<video src>` streams and seeks progressively.
- **Pros:** zero video bytes through the API; matches the diagram; Range/206 handled by S3/MinIO (battle-tested); the stable API URL stays the public contract while signatures rotate.
- **Cons:** the storage endpoint must be reachable by the client (public endpoint vs internal Docker hostname); URLs expire (the player re-requests the API URL).

### Option C: Adaptive streaming (HLS/DASH transcoding in the worker)
- **Pros:** adaptive bitrate, best playback experience.
- **Cons:** transcoding a 10GB file is heavy (CPU/time/storage ×N renditions); not required by the phase ("sem necessidade de download completo" is satisfied by progressive streaming with Range); belongs to a future optimization.

**Recommendation:** Option B — progressive streaming with Range served by the storage through presigned redirects satisfies streaming and download without moving bytes through the API; HLS is out of the phase's scope.

**Decision:** _[pending]_

---

## TD-09: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The phase requires a draft to exist as soon as the upload starts and processing to happen automatically after it ends. The status set, the transitions, who performs each one, and what happens when processing fails define the DB enum, the queue job semantics and the API error catalog.

**Options:**

### Option A: Four states `draft → processing → ready | failed`, retries with backoff, idempotent consumer
- `draft`: row created at upload initiation (multipart upload id stored). `processing`: set by the API when the upload is completed and the object verified, in the same transaction that enqueues the job (`jobId = videoId`, deduplicated by BullMQ). `ready`: set by the worker after metadata + thumbnail are stored. `failed`: set by the worker when the last attempt fails (or immediately for unrecoverable input, e.g., no video stream), with `processing_error`. The worker only acts on videos in `processing` (idempotent: duplicate or stale jobs are discarded). Retry: 3 attempts, exponential backoff.
- **Pros:** every transition has a single owner; failures are visible to the owner; at-least-once delivery is safe.
- **Cons:** a draft whose upload is abandoned remains `draft` until aborted (cleanup job is a future concern).

### Option B: Add `uploading` and `uploaded` intermediate states
- **Pros:** finer UI feedback.
- **Cons:** `uploading` cannot be observed by the API (bytes go direct to storage — TD-02), `uploaded` lasts milliseconds before `processing`; more transitions to test without user value.

### Option C: No `failed` state — retry forever
- **Pros:** simpler enum.
- **Cons:** corrupt/non-video files would retry forever and the owner never learns the upload is unusable.

**Recommendation:** Option A — the minimal state set that reflects what the system can actually observe, with explicit terminal failure and an idempotent at-least-once consumer.

**Decision:** _[pending]_

---

## TD-10: Upload Limits and Accepted Formats

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Limits are values that appear in Joi config, DTO validation, the error catalog and tests. They must respect S3 multipart limits (TD-02).

**Options:**

### Option A: Max 10 GiB, part size 100 MiB (configurable), video MIME allowlist, size verified after completion
- `VIDEO_MAX_SIZE_BYTES = 10737418240` (10 GiB); `VIDEO_UPLOAD_PART_SIZE_MB = 100` → 103 parts for 10 GiB (≪ 10,000; ≥ 5 MiB minimum); declared `content_type` ∈ {`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`}; after `CompleteMultipartUpload` the API compares `HeadObject.ContentLength` with the declared size and rejects mismatches; the worker rejects files without a video stream (TD-09 `failed`).
- **Pros:** the limit is enforced at initiation (declared size), at completion (real size) and by the number of signed parts (no part beyond `part_count` is signed); configurable for tests (small part size).
- **Cons:** the client-declared MIME type is only a hint — real validation happens in the worker (ffprobe).

### Option B: No server-side size limit, rely on storage quotas
- **Pros:** less code.
- **Cons:** does not enforce the phase's 10GB contract; storage abuse.

**Recommendation:** Option A — enforce the 10 GiB contract at three points with S3-compatible part sizing, keeping values in config so tests can use small parts.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message queue technology | A (BullMQ + Redis) | _[pending]_ |
| TD-02 | Cross-layer | Upload protocol for files up to 10GB | C (S3 multipart with presigned part URLs) | _[pending]_ |
| TD-03 | Backend | Object storage usage (SDK, layout, signing) | A (AWS SDK v3, one private bucket, per-video prefix) | _[pending]_ |
| TD-04 | Repo-wide | Video worker runtime | A (same codebase, separate entrypoint/container) | _[pending]_ |
| TD-05 | Backend | FFmpeg integration and source access | B (spawn ffprobe/ffmpeg over presigned URL) | _[pending]_ |
| TD-06 | Backend | Thumbnail generation strategy | B (10% offset, JPEG 1280px) | _[pending]_ |
| TD-07 | Cross-layer | Unique video URL identifier | B (11-char base64url random slug + unique index) | _[pending]_ |
| TD-08 | Cross-layer | Streaming and download delivery | B (302 to presigned storage URL, Range/206 by storage) | _[pending]_ |
| TD-09 | Backend | Video status lifecycle and failure handling | A (draft → processing → ready/failed, retries, idempotent) | _[pending]_ |
| TD-10 | Backend | Upload limits and accepted formats | A (10 GiB, 100 MiB parts, MIME allowlist, size check) | _[pending]_ |
