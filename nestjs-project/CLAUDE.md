# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO bucket:** `docker compose logs minio-init` — expect `bucket streamtube-videos ready` (the service exits with code 0 once the bucket exists)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker ready — consuming the video-processing queue` (it starts with `docker compose up` once `node_modules` exists; it is infrastructure, not the API server)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, Web UI/API `8025`
- `redis` — Redis 7.4 for BullMQ (`--maxmemory-policy noeviction`, AOF), internal only
- `minio` — S3-compatible object storage (`cgr.dev/chainguard/minio`, pinned by digest), port `9000`, network alias `minio.localhost`; credentials from `S3_ACCESS_KEY`/`S3_SECRET_KEY` in `.env`
- `minio-init` — one-shot `amazon/aws-cli` that creates the `S3_BUCKET` bucket and exits
- `video-worker` — same image/bind mount as the API, runs `npm run start:worker:dev` (BullMQ consumer + FFmpeg)

`.env` is read by Docker Compose too (`${S3_ACCESS_KEY}` etc.): copy `.env.example` to `.env` before `docker compose up`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (dist/worker.js)
npm run migration:run                    # Apply migrations (incl. CreateVideos)
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured (test/jest-e2e.json → "maxWorkers": 1)
```

Video tests need the whole stack up (`db`, `redis`, `minio`, `minio-init`, `video-worker`): `test/video-pipeline.e2e-spec.ts` waits for the **`video-worker` container** to process the uploaded file, and storage/media tests talk to the real MinIO and run the real `ffmpeg`/`ffprobe` of the image.

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings
- **ESLint in tests:** `*.spec.ts`, `*.integration-spec.ts` and `*.e2e-spec.ts` turn off `no-unsafe-assignment/member-access/return/call`, `unbound-method` and `require-await` (Jest mocks and supertest bodies are `any`); production code keeps the full type-checked set

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03)

Upload, processing, unique URL and streaming of videos. Plan and decisions: `docs/phases/phase-03-videos/phase-03-videos.md`, `docs/decisions/technical-decisions-phase-03-videos.md`.

### Code map

| Path | Role |
|------|------|
| `src/videos/videos.module.ts` | API side: controller, `VideosService`, producer of the `video-processing` queue |
| `src/videos/videos.controller.ts` | HTTP routes below; class-level `@Throttle({ default: { limit: 120, ttl: 60000 } })` overrides the global 10 req/min of `AuthModule` |
| `src/videos/videos.service.ts` | Draft creation, multipart handshake, enqueue, read rules (ready-only public reads) |
| `src/videos/entities/video.entity.ts` | `Video` (`videos` table) + `VideoStatus` enum; `channel_id` FK with `ON DELETE CASCADE`; `upload_id` is `select: false` |
| `src/videos/videos.exceptions.ts` | Domain errors (`VIDEO_NOT_FOUND`, `VIDEO_TOO_LARGE`, `VIDEO_NOT_IN_DRAFT`, `INVALID_PART_NUMBER`, `INVALID_UPLOAD_PARTS`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`, `CHANNEL_NOT_FOUND`) |
| `src/videos/processing/` | Worker side: `VideoProcessingProcessor` (BullMQ `WorkerHost`), `VideoProcessingService`, `MediaToolsService` (spawns `ffprobe`/`ffmpeg`) |
| `src/storage/storage.service.ts` | Only place that talks to S3/MinIO (two clients: internal `S3_ENDPOINT`, public `S3_PUBLIC_ENDPOINT` used only to sign client URLs) |
| `src/queue/` | `QueueModule` (BullMQ root connection) and the queue/job constants |
| `src/worker.ts`, `src/worker.module.ts` | Worker process: Nest application context without HTTP; only place where `VideoProcessingModule` is imported |
| `src/database/migrations/1794421231714-CreateVideos.ts` | `videos` table + `videos_status_enum` |

### Endpoints

| Method & path | Auth | Result |
|---------------|------|--------|
| `POST /videos` | Bearer | 201 — draft created (`status: draft`, 11-char `slug`) + `upload: { part_size, part_count, max_parts_per_request }` |
| `POST /videos/:slug/upload-parts` | Bearer (owner) | 200 — presigned `PUT` URLs for up to 100 parts |
| `POST /videos/:slug/complete-upload` | Bearer (owner) | 200 — parts assembled, size checked, `status: processing`, job enqueued |
| `DELETE /videos/:slug/upload` | Bearer (owner) | 204 — multipart aborted, draft removed |
| `GET /videos/:slug/status` | Bearer (owner) | 200 — any status + `processing_error` |
| `GET /videos/:slug` | Public | 200 — ready video (duration, metadata, channel, stream/download/thumbnail URLs); 404 otherwise |
| `GET /videos/:slug/stream` | Public | 302 → presigned URL; the storage answers `Range` with `206 Partial Content` |
| `GET /videos/:slug/download` | Public | 302 → presigned URL with `Content-Disposition: attachment` (original filename, UTF-8) |
| `GET /videos/:slug/thumbnail` | Public | 302 → presigned JPEG |

Upload flow: the file **never** goes through the API. The client splits it in `part_size` chunks, `PUT`s each chunk to the signed URL, keeps each `ETag` response header and sends `{ parts: [{ part_number, etag }] }` to `complete-upload`. Limit: `VIDEO_MAX_SIZE_BYTES` = 10 GiB (10737418240); part size `VIDEO_UPLOAD_PART_SIZE_MB` = 100 → 103 parts for 10 GiB.

### Status lifecycle and the queue

`draft` (row created by `POST /videos`) → `processing` (set by `complete-upload` in the same transaction that enqueues `process-video` with `jobId = videoId`, 3 attempts, exponential backoff 5 s) → `ready` (worker stored `duration_seconds`, `metadata`, `thumbnail_key`) **or** `failed` (`processing_error`; immediately for non-video files/missing object via `UnrecoverableError`, otherwise after the last attempt). The worker only acts on videos in `processing` (idempotent) — duplicate/stale jobs log `Skipping video …` and do nothing.

Storage keys: `videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg` (thumbnail = frame at 10% of the duration, max 10 s, width 1280).

### Environment variables

`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `VIDEO_MAX_SIZE_BYTES`, `VIDEO_UPLOAD_PART_SIZE_MB`, `VIDEO_URL_TTL_SECONDS`, `VIDEO_PROCESSING_ATTEMPTS`, `VIDEO_PROCESSING_BACKOFF_MS`, `VIDEO_FFMPEG_TIMEOUT_MS` — validated in `src/config/env.validation.ts`, read by `src/config/{storage,queue,video}.config.ts`.

`S3_PUBLIC_ENDPOINT=http://minio.localhost:9000` is the one deliberate exception to "never localhost": it is only used to **sign URLs for clients outside Docker** (browsers resolve `*.localhost` to 127.0.0.1); containers reach the same name through the `minio.localhost` network alias. Service-to-service calls keep `S3_ENDPOINT=http://minio:9000`.

### Gotchas

- Use `@nestjs/bullmq` **11.x** (CommonJS). 12.x is ESM-only and breaks the CommonJS Jest runtime; BullMQ 6 also needs `ioredis` installed explicitly.
- Every `S3Client` sets `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'`; without it presigned part URLs demand checksum headers a browser `PUT` does not send.
- `TypeOrmModule.forFeature([Video])` alone is not enough in a process that does not import the rest of the app: the worker imports `UsersModule` to register the `Video → Channel → User` entity graph.
- Never register `VideoProcessingModule`/`VideoProcessingProcessor` in a test module: it would start a BullMQ worker inside Jest and consume the shared queue. Test the services directly; publisher tests use `queue.getJob(videoId)`.
- Test media are generated on the fly by `src/test/test-media.ts` (`ffmpeg -f lavfi`); do not commit binary fixtures.
