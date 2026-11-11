# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/9 completed

### SI-03.1 — Infrastructure: Compose Services, FFmpeg Image, Dependencies and Config Namespaces
- **Status:** completed
- **Tests:** 7/7 passing (env.validation.integration-spec.ts — 4 existing + 3 new)
- **Observations:**
  - **Infra verified on the dev host:** `docker compose up -d --build` started redis (healthy, `PONG`), minio, minio-init (`make_bucket: streamtube-videos`) and nestjs-api; `ffprobe version 5.1.9-0+deb12u1` inside nestjs-api (Debian bookworm package).
  - **Needed by this SI, outside the original plan text:** `.env.example` had `MAIL_FROM="StreamTube" <noreply@streamtube.com>` unquoted — Docker Compose (which now interpolates `S3_*` from `.env`) refused to parse it (`unexpected character "<"`). The value is now single-quoted; same string at runtime.
  - `video-worker` restarts in a loop until SI-03.7 adds `npm run start:worker:dev` — expected at this point.
  - Prettier applied with `npx prettier --write` inside the container (the Windows checkout uses CRLF; the repository stores LF).

### SI-03.2 — Storage Module (S3 API over MinIO)
- **Status:** completed
- **Tests:** 7/7 passing (storage.service.integration-spec.ts: 6, storage.module.spec.ts: 1)
- **Observations:**
  - Presigned part URLs signed for `S3_PUBLIC_ENDPOINT` (`minio.localhost:9000`) were PUT from inside the `nestjs-api` container through the network alias — confirms the IC-2 resolution in practice.
  - `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'` set on both clients as documented in `library-refs.md`; with it, browser-style PUTs to presigned part URLs succeed (no `x-amz-checksum-*` requirement).
  - Node 25 `fetch` typings reject `Buffer` bodies in `tsc`; tests wrap them in `Uint8Array`.

### SI-03.3 — Video Entity, Migration and Channel Lookup
- **Status:** completed
- **Tests:** full unit+integration run: 161/162 then the single timeout re-run green (25/25 twice); SI files: video.entity.integration-spec.ts 6/6, migrations.integration-spec.ts 2/2, channels.service.integration-spec.ts 5/5 (2 new for findByUserId)
- **Observations:**
  - Migration `1794421231714-CreateVideos.ts` generated with `npm run migration:generate` against the migrated dev DB (rule `typeorm-migrations.md`), then formatted with Prettier.
  - **Needed earlier than planned:** adding the inverse `Channel.videos` relation makes `AppModule` fail to boot unless `Video` is registered in some `TypeOrmModule.forFeature` (`openapi-export.integration-spec.ts` hit `process.exit(1)`). A minimal `VideosModule` (only `forFeature([Video])`) was created here and registered in `AppModule`; SI-03.4 grows it.
  - All existing integration/module specs with explicit entity arrays now include `Video` (TypeORM needs every entity of a relation graph).
  - `auth.service.integration-spec.ts` › 'does not revoke tokens from other users' exceeded the 5 s Jest timeout once while the dev host had load average 6.7 on 6 cores (Argon2 hashing); green on two re-runs. `video-worker` stopped until SI-03.7 to avoid its restart loop.

### SI-03.4 — Draft Pre-registration and Multipart Initiation (`POST /videos`)
- **Status:** completed
- **Tests:** unit: video-slug.util.spec 2/2, videos.service.spec 9/9, videos.module.spec 1/1; integration: videos.service.integration-spec 2/2 (real DB + MinIO); e2e: test/videos.e2e-spec.ts POST /videos 5/5
- **Observations:**
  - **Library discrepancy (flagged per CLAUDE.md):** `@nestjs/bullmq@^12.0.1` is ESM-only and the project's CommonJS Jest cannot load it (`SyntaxError: Unexpected token 'export'`). Switched to `@nestjs/bullmq@^11.0.5` (CommonJS, NestJS 11, peer `bullmq ^6`) and added `ioredis@^5.11.1`, which BullMQ 6 made an optional peer. Recorded as a `Revisions:` entry in TD-01 and in `library-refs.md`; same decorators/APIs.
  - `src/test/videos-test-module.ts` centralizes the testing module wired to real db/minio/redis plus a channel-owner factory, reused by the next SIs; the `video` config namespace is overridden there (5 MiB parts) to exercise multipart without large files.
  - Draft multipart uploads created by the e2e/integration tests are aborted where the test owns the UploadId; drafts left by e2e stay as pending uploads in the dev bucket (no bytes).

### SI-03.5 — Upload Handshake: Sign Parts, Complete (enqueue) and Abort
- **Status:** completed
- **Tests:** unit: videos.service.spec 23/23 (9 createDraft + 14 handshake); integration: videos.service.integration-spec 7/7 (2-part upload via presigned URLs → processing + job by id; size mismatch → failed + object removed; wrong ETag → UploadIncomplete; abort invalidates part URLs; foreign slug → 404), storage.service.integration-spec 6/6 (abort now idempotent); e2e: videos.e2e-spec 11/11
- **Observations:**
  - `StorageService.abortMultipartUpload` made idempotent (`NoSuchUpload` = already aborted) so aborting a draft whose upload expired on the storage does not 500.
  - Publisher test asserts the job with `queue.getJob(videoId)` (deterministic id) rather than `getJobs(['waiting'])`, as revised in the testing guide — the `video-worker` container consumes the queue concurrently once SI-03.7 is in.
  - Jobs enqueued by tests whose rows are cleaned afterwards are left in Redis; the idempotent consumer (SI-03.6) skips them.

### SI-03.6 — Video Processing: FFprobe Metadata, Thumbnail and Failure Handling
- **Status:** completed
- **Tests:** 33/33 passing — unit: media-tools.service.spec 9, video-processing.service.spec 10, video-processing.processor.spec 8; integration: media-tools.service.integration-spec 3 (real ffprobe/ffmpeg over a presigned MinIO URL), video-processing.service.integration-spec 3 (ready with duration/metadata/thumbnail; idempotent re-run; non-video → failed)
- **Observations:**
  - Test media are generated at test time by `src/test/test-media.ts` (`ffmpeg -f lavfi testsrc2 + sine`, libx264/aac) — no binary fixtures. 3 s at 320×240 ≈ 190 KB; 3 s at 1280×720 / 30 Mbps ≈ 12.8 MB (used by the SI-03.8 e2e for 3 parts of 5 MiB).
  - `MediaToolException.invalidInput` classifies ffprobe stderr (`Invalid data found when processing input`, `moov atom not found`, …) as permanent → `InvalidVideoMediaException` → `UnrecoverableError`; any other tool failure (timeouts, connection errors) is retried by BullMQ.
  - The integration test wires `VideoProcessingService` + `MediaToolsService` without `VideoProcessingModule`, so no BullMQ worker is started inside Jest (it would consume the shared queue); `createVideosTestingModule` gained an optional `providers` argument.

### SI-03.7 — Worker Entrypoint and Container
- **Status:** completed
- **Tests:** worker.module.spec 1/1 (+ openapi-export.integration-spec 9/9 re-run after the AppModule factory extraction); runtime check: `docker compose ps` → video-worker Up, log 'Video worker ready — consuming the video-processing queue'
- **Observations:**
  - **Fixed during the SI:** first boot of the worker failed with `Entity metadata for Video#channel was not found` — `autoLoadEntities` only knew `Video`. `VideoProcessingModule` now imports `UsersModule` (which imports `ChannelsModule`), registering the `Video → Channel → User` graph through the owning modules.
  - Right after boot the worker consumed the jobs left in Redis by the SI-03.5 tests and logged `Skipping video …: not found` for each — the idempotent-consumer behaviour of TD-09 observed live.
  - `start:worker:dev` runs `node --watch -r ts-node/register src/worker.ts` with `TS_NODE_TRANSPILE_ONLY=true` (no `dist/` sharing with the API's `nest start --watch`, which deletes `dist` on start); `node --watch` restarted the worker automatically when the module file changed.

### SI-03.8 — Read Endpoints: Video, Owner Status, Stream, Download and Thumbnail
- **Status:** completed
- **Tests:** unit: videos.service.spec 35/35 (+12 read rules, attachmentDisposition); e2e: full `npm run test:e2e` 5 suites / 66 tests green — new test/video-pipeline.e2e-spec.ts 3/3 (≈12.8 MB video uploaded in 3 presigned parts → processed by the real `video-worker` container in ~3 s → `/stream` 302 → `Range: bytes=0-1023` answered `206` with `Content-Range`; `/download` 302 → `Content-Disposition` with `filename*=UTF-8''F%C3%A9rias%20na%20praia.mp4` and byte-identical body; `/thumbnail` 302 → `image/jpeg`; non-video upload → `failed` + public 404; drafts hidden from public routes)
- **Observations:**
  - **Test infra:** `test/jest-e2e.json` gained `"maxWorkers": 1`. The e2e suites share the `db` database and call `cleanAllTables()`; with five suites Jest would run them in parallel workers (the script has no `--runInBand`), wiping rows the pipeline test is waiting on. `nestjs-project/CLAUDE.md` already states e2e must run in band — the config now enforces it.
  - The pipeline e2e overrides the `video` config namespace with 5 MiB parts (`overrideProvider(videoConfig.KEY)`) so a 12.8 MB sample exercises a real 3-part multipart upload; the worker container keeps its own config.
  - Public routes return `302` through `@Redirect()` with a dynamic URL; the Location host is `minio.localhost:9000` (S3_PUBLIC_ENDPOINT) and the test container follows it through the Compose alias — the same URL a browser on the host would get.

### SI-03.9 — OpenAPI Contract and AI Documentation
- **Status:** completed
- **Tests:** openapi-export.integration-spec 12/12 (3 new: the 9 video operations with summary and `videos` tag; bearer security exactly on the 5 owner routes; 302 documented on `/stream`)
- **Observations:**
  - `openapi.json` regenerated with `npm run openapi:export` (+987 lines: 9 video paths, request/response DTO schemas with explicit `@ApiProperty`).
  - Plan text said '8 video operations' in SI-03.9; the API Contracts list 9 (5 owner + 4 public) — corrected in the plan.
  - `CLAUDE.md` (root: queue = BullMQ/Redis, MinIO, worker) and `nestjs-project/CLAUDE.md` (new services and readiness checks, worker/migration/openapi commands, e2e `maxWorkers: 1`, ESLint test overrides, new 'Videos (Phase 03)' section with code map, endpoints, lifecycle, env vars and gotchas). Every `src/`, `test/`, `docs/` path and npm script cited was checked to exist.
  - `api.http` gained the video requests (10–18); `docs/diagrams/software-arch.mermaid` queue container changed from `TBD` to `BullMQ (Redis)`.
  - `next-frontend/openapi.json` was not synced (`scripts/sync-openapi.sh`): the frontend is out of scope for this phase.
