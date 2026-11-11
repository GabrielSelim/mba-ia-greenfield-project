---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-11T14:00:23-04:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T13:59:05-04:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide prescribes local-filesystem storage; TD-03 uses S3 API/MinIO"
  - id: IC-2
    status: open
    summary: "Presigned URLs need a client-reachable host vs 'never localhost' rule"
  - id: AMB-1
    status: open
    summary: "'até 10GB' — decimal GB or binary GiB limit?"
  - id: MD-1
    status: open
    summary: "No TD decides who may stream/download/read a video"
  - id: DG-1
    status: open
    summary: "Phase 02 exposes no lookup of the caller's channel by user id"
  - id: ICC-1
    status: open
    summary: "Global ThrottlerGuard (10 req/min/IP) would throttle the upload handshake"
  - id: OQ-1
    status: open
    summary: "TD-01 (queue technology) is pending"
  - id: OQ-2
    status: open
    summary: "TD-02 (upload protocol) is pending"
  - id: OQ-3
    status: open
    summary: "TD-03 (object storage usage) is pending"
  - id: OQ-4
    status: open
    summary: "TD-04 (worker runtime) is pending"
  - id: OQ-5
    status: open
    summary: "TD-05 (FFmpeg integration) is pending"
  - id: OQ-6
    status: open
    summary: "TD-06 (thumbnail strategy) is pending"
  - id: OQ-7
    status: open
    summary: "TD-07 (unique URL identifier) is pending"
  - id: OQ-8
    status: open
    summary: "TD-08 (streaming/download delivery) is pending"
  - id: OQ-9
    status: open
    summary: "TD-09 (status lifecycle) is pending"
  - id: OQ-10
    status: open
    summary: "TD-10 (upload limits) is pending"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § "Object Storage — Local Filesystem" says _"Local filesystem storage in development and tests. S3 in production"_ with a `StorageService` local adapter, while `phase-03-videos/TD-03` (and the phase brief: "na prática você roda MinIO localmente em Docker") makes every environment speak the S3 API against MinIO, and the inherited convention says external systems run as real Compose services. A local-filesystem adapter cannot exercise presigned multipart URLs (TD-02) nor storage-served Range requests (TD-08). Explicit choice: (a) tests use the real MinIO service from `compose.yaml` and the testing-guide reference is revised accordingly; (b) keep a filesystem adapter for tests (TD-02/TD-08 would then be untestable without mocks).
- **IC-2** — `CLAUDE.md` § Docker Networking: _"always use the Docker Compose service name as the host — never `localhost` or `127.0.0.1`"_, but TD-02 and TD-08 hand presigned URLs to a client **outside** Docker (browser/curl on the host), which cannot resolve `minio`; AWS SigV4 signs the `host` header, so the URL cannot be rewritten after signing. Explicit choice: decide the host used to sign client-facing URLs (separate public endpoint config) and how it stays reachable both from the host machine and from containers that run the tests, without breaking the service-name rule for service-to-service calls.

### Ambiguities

- **AMB-1** — Capability "Upload de vídeos com suporte a arquivos de até 10GB" does not say whether 10GB means 10 × 10⁹ bytes or 10 GiB (10 × 2³⁰ = 10,737,418,240 bytes). TD-10 proposes `10737418240` but the phase text is ambiguous. Explicit choice: fix the exact byte limit used in config, DTO validation and the error catalog.

### Missing Decisions

- **MD-1** — "Reprodução via streaming" and "Download do vídeo pelo usuário" require deciding **who** may read a video (anonymous visitor, any authenticated user, or only the channel owner) and in which status. TD-08 decides _how_ bytes are delivered, not the access policy; Phase 04 owns visibility (público/unlisted) and Phase 05 owns "acesso anônimo à visualização", so the boundary for Phase 03 must be explicit. Explicit choice: run `/research` to add a TD covering the read access policy for video metadata, stream, download and thumbnail.

### Dependency Gaps

- **DG-1** — Every owner operation (create draft, sign parts, complete, abort, status) must resolve the caller's channel from `JwtPayload.sub`. Phase 02 delivered `ChannelsService.createChannel()` only — there is no lookup by user id (`src/channels/channels.service.ts`). Explicit choice: add a `findByUserId` capability to `ChannelsModule` in this phase (owned by the channels domain, consumed by videos), keeping the Single Responsibility rule from `CLAUDE.md`.

### Inherited Constraint Conflicts

- **ICC-1** — `phase-02-auth/TD-08` registers `ThrottlerGuard` as `APP_GUARD` in `AuthModule` with `ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])` (`src/auth/auth.module.ts`). `APP_GUARD` providers are global, so every new video route inherits **10 requests/min per IP**. The TD-02 handshake for a 10GB file (create + several sign-parts batches + complete) plus status polling can exceed that, breaking uploads. Explicit choice: define the throttling policy for the videos routes (override limit or skip) without changing the auth endpoints' policy.

### Unresolved Open Questions

- **OQ-1** — `phase-03-videos/TD-01` (Message Queue Technology) has `Decision: _[pending]_`.
- **OQ-2** — `phase-03-videos/TD-02` (Upload Protocol for Files up to 10GB) has `Decision: _[pending]_`.
- **OQ-3** — `phase-03-videos/TD-03` (Object Storage Usage) has `Decision: _[pending]_`.
- **OQ-4** — `phase-03-videos/TD-04` (Video Worker Runtime) has `Decision: _[pending]_`.
- **OQ-5** — `phase-03-videos/TD-05` (FFmpeg Integration and Source Access) has `Decision: _[pending]_`.
- **OQ-6** — `phase-03-videos/TD-06` (Thumbnail Generation Strategy) has `Decision: _[pending]_`.
- **OQ-7** — `phase-03-videos/TD-07` (Unique Video URL Identifier) has `Decision: _[pending]_`.
- **OQ-8** — `phase-03-videos/TD-08` (Streaming and Download Delivery) has `Decision: _[pending]_`.
- **OQ-9** — `phase-03-videos/TD-09` (Video Status Lifecycle and Failure Handling) has `Decision: _[pending]_`.
- **OQ-10** — `phase-03-videos/TD-10` (Upload Limits and Accepted Formats) has `Decision: _[pending]_`.

### UI Coverage Gaps

_None._ (no UI scope in this phase)

## Resolved Issues

_No issues resolved yet._
