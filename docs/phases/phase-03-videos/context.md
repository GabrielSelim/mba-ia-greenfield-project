---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-11T13:26:09-04:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T14:01:56-04:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-11T14:03:19-04:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-11-11T13:29:59-04:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-11T13:29:59-04:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-11T13:29:59-04:00"
  docs/phases/phase-02-auth/context.md: "2026-11-11T13:29:59-04:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-11-11T13:29:59-04:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-11T13:26:09-04:00"
  .claude/skills/testing-guide-nestjs-project/references/external-systems.md: "2026-11-11T14:03:45-04:00"
  .claude/skills/testing-guide-nestjs-project/artifacts/future-types.md: "2026-11-11T13:26:09-04:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição de título/descrição/categoria e thumbnail customizada, visibilidade (público/unlisted) e fluxo rascunho → publicação, painel do canal (Fase 04); player, página de visualização, contagem de views (Fase 05); qualquer tela do `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API, worker, migration, Compose).

**Deferred subprojects:** `next-frontend/` — a interface de vídeo não faz parte do escopo desta fase (desafio backend). Os contratos (upload multipart, URLs de stream/download) ficam documentados no OpenAPI para consumo futuro.

**Sequencing notes:** Depende de Fase 01 (config, TypeORM, Docker) e Fase 02 (usuários, canais 1:1, guard JWT global, filtro de exceções de domínio).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — cada usuário tem um canal (1:1) criado no cadastro; JWT carrega `sub` (user id) e `email`.
- **Phase 04:** Gerenciamento de Vídeos e Canal — edição de informações, visibilidade, rascunho → publicação, thumbnail customizada.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | bullmq@^6.7.4, @nestjs/bullmq@^12.0.1 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Protocol for Files up to 10GB | decided | C (S3 multipart with presigned part URLs) | @aws-sdk/client-s3@^3.1166.0, @aws-sdk/s3-request-presigner@^3.1166.0 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Usage — SDK, Layout, Signing | decided | A (AWS SDK v3, one private bucket, per-video prefix, internal + public endpoint) | @aws-sdk/client-s3@^3.1166.0, @aws-sdk/s3-request-presigner@^3.1166.0 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Repo-wide | Video Worker Runtime | decided | A (same codebase, separate entrypoint/container) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | FFmpeg Integration and Source Access | decided | B (spawn ffprobe/ffmpeg over presigned URL) | — (system `ffmpeg`/`ffprobe`) |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Thumbnail Generation Strategy | decided | B (10% offset capped at 10s, JPEG 1280px) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Unique Video URL Identifier | decided | B (11-char base64url random slug) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming and Download Delivery | decided | B (302 to presigned storage URL) | @aws-sdk/s3-request-presigner@^3.1166.0 |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Handling | decided | A (draft → processing → ready / failed) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Upload Limits and Accepted Formats | decided | A (10 GiB, 100 MiB parts, MIME allowlist) | — |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Cross-layer | Read Access Policy for Videos | decided | A (ready videos public by unique URL; others 404) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)
- openapi-docs-nestjs — `docs/decisions/technical-decisions-openapi-docs-nestjs.md` (scope_type: ad-hoc, `related_phases: []`; correlated because every new endpoint must be documented and exported to `openapi.json`)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08, phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — native NestJS integration and built-in retry/backoff/deduplication cover the "process one heavy job reliably" need with the least custom code; the dual-write risk is handled by an idempotent consumer (see TD-09).
**Decision:** A — queue `video-processing` on `redis:7.4.12-alpine` with `--maxmemory-policy noeviction`; producer in the API, consumer only in the worker.
**Libraries:** `bullmq@^6.7.4`, `@nestjs/bullmq@^12.0.1`

### phase-03-videos/TD-02

**Recommendation:** S3 multipart with presigned part URLs — the only option that keeps every video byte off the API and meets the 10GB target within S3 limits, with part-level retry.
**Decision:** C — `POST /videos` → `POST /videos/{slug}/upload-parts` → `POST /videos/{slug}/complete-upload`; `DELETE /videos/{slug}/upload` aborts. `VideosController` overrides the inherited throttler with 120 req/min (ICC-1).
**Libraries:** `@aws-sdk/client-s3@^3.1166.0`, `@aws-sdk/s3-request-presigner@^3.1166.0`

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3 with one private bucket and per-video key prefixes (`videos/{id}/original`, `videos/{id}/thumbnail.jpg`); local MinIO from `cgr.dev/chainguard/minio` pinned by digest, bucket created by a one-shot `amazon/aws-cli` service.
**Decision:** A — internal client on `S3_ENDPOINT=http://minio:9000`; client-facing URLs signed with `S3_PUBLIC_ENDPOINT=http://minio.localhost:9000` (network alias `minio.localhost` on the `minio` service, IC-2); tests use the real MinIO (IC-1). Both clients use `requestChecksumCalculation: WHEN_REQUIRED` (see `library-refs.md`).
**Libraries:** `@aws-sdk/client-s3@^3.1166.0`, `@aws-sdk/s3-request-presigner@^3.1166.0`

### phase-03-videos/TD-04

**Recommendation:** same NestJS codebase with a separate entrypoint (`src/worker.ts`, application context without HTTP) running in its own `video-worker` Compose service built from the same Dockerfile (with FFmpeg).
**Decision:** A.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** spawn `ffprobe`/`ffmpeg` directly (no deprecated wrapper) and read the source through a presigned HTTP URL, so 10GB sources need no local disk.
**Decision:** B.
**Libraries:** — (system binaries)

### phase-03-videos/TD-06

**Recommendation:** frame at `min(duration × 0.1, 10s)`, JPEG scaled to width 1280, stored at `videos/{id}/thumbnail.jpg`.
**Decision:** B.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** 11-char base64url slug from 8 random bytes, `UNIQUE` index and bounded retry on `23505`.
**Decision:** B.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** API authorizes and answers `302` to a short-lived presigned storage URL (inline for stream, `attachment` for download); Range/`206 Partial Content` served by the storage.
**Decision:** B — `/videos/{slug}/stream`, `/download`, `/thumbnail`.
**Libraries:** `@aws-sdk/s3-request-presigner@^3.1166.0`

### phase-03-videos/TD-09

**Recommendation:** `draft → processing → ready | failed`; processing enqueued with `jobId = videoId`; 3 attempts with exponential backoff; idempotent worker acting only on `processing` videos.
**Decision:** A — `attempts: 3`, exponential backoff 5s; `UnrecoverableError` for invalid media/missing object.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** max 10 GiB, part size 100 MiB (configurable), MIME allowlist (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`), real size verified with `HeadObject` after completion.
**Decision:** A — limit fixed at 10,737,418,240 bytes (AMB-1).
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** link-only public read of ready videos is the product rule from the overview, needs no change in later phases, and hides non-ready videos behind 404.
**Decision:** A — owner follows any status at `GET /videos/{slug}/status` (authenticated).
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** `@nestjs/config` — official, core-team-maintained, NestJS 11 compatible; `registerAs()` solves sharing config with the TypeORM CLI.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — first-class integration with `@nestjs/config` via `validationSchema`, native string-to-number coercion.
**Libraries:** `joi`

### phase-01-configuracao-base/TD-03

**Recommendation:** namespaced config with `registerAs` — one file per domain in `src/config/`, typed injection via `ConfigType<typeof xxxConfig>`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** shared `registerAs` factory between the Nest app and `data-source.ts` (TypeORM CLI).
**Libraries:** `dotenv`

### phase-02-auth/TD-02

**Recommendation:** custom JWT guard with `@nestjs/jwt` registered globally (`APP_GUARD`); routes are protected by default and opt out with `@Public()`.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer DTOs with a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** custom domain exception filter — services throw `DomainException` subclasses; response `{ statusCode, error, message }` with a domain error code.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` + CLI plugin; every controller documented with `@ApiTags`, `@ApiOperation`, `@ApiResponse` (errors referencing `ApiErrorEnvelope`), `@ApiBearerAuth('access-token')` on protected routes.
**Libraries:** `@nestjs/swagger@^11.0.0`

### openapi-docs-nestjs/TD-02

**Recommendation:** runtime Swagger UI + exported `openapi.json` (`npm run openapi:export`) as the contract consumed by the frontend.
**Libraries:** —

## Inherited Conventions

- Config: one `registerAs` namespace per domain in `src/config/`, validated by the Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via generated migrations. _(from phase 01)_
- Docker networking: services talk to each other by Compose service name (`db`, `mailpit`), never `localhost`. _(from phase 01 / `CLAUDE.md`)_
- Every endpoint is protected by the global `JwtAuthGuard`; public routes use `@Public()`; the authenticated user arrives as `JwtPayload { sub, email }` via `@CurrentUser()`. _(from phase 02)_
- Services throw `DomainException` subclasses (`src/common/exceptions/domain.exception.ts`), never Nest HTTP exceptions; `DomainExceptionFilter` maps them. _(from phase 02)_
- Each user owns exactly one channel (`channels.user_id` unique), created atomically at registration by `ChannelsService`. _(from phase 02)_ Phase 03 adds `ChannelsService.findByUserId()` to resolve the caller's channel (DG-1).
- Integration/e2e suites share the `db` database and run `--runInBand`; tables are cleaned with `cleanAllTables()` from `src/test/create-test-data-source.ts`. _(from phase 02)_
- External systems in tests are real Compose services (PostgreSQL, Mailpit) — no mocks of what Compose can run. _(from phase 02 / testing guide)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` não estava inicializado na fase 02 (depois entregue em `phase-02-auth-frontend`). Não afeta a fase 03. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

Source: `testing-guide-nestjs-project` (SKILL.md, `references/external-systems.md`, `artifacts/future-types.md`).

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration (real DB): constraints, defaults, unique indexes |
| Service with branching + DB | Unit (branch logic, mocked repo/collaborators) + Integration (DB contract) |
| Service with side-effect dependency (storage, queue) | Integration against the real Compose service |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only (supertest) |
| DTO | E2E: one validation-wiring test per endpoint |
| Queue processor (BullMQ) | Unit (branch logic) + Integration (real DB/storage, `process(job)` called directly) |
| Migration | Integration: apply/revert through the migration runner |

Specific layer coverage per SI is recorded in `progress.md`.
