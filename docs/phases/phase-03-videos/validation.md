---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-11T14:04:28-04:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T14:01:56-04:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-11T14:03:19-04:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-filesystem storage; TD-03 uses S3 API/MinIO"
    resolved_by: phase-03-videos/TD-03
  - id: IC-2
    status: resolved
    summary: "Presigned URLs need a client-reachable host vs 'never localhost' rule"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-1
    status: resolved
    summary: "'até 10GB' — decimal GB or binary GiB limit?"
    resolved_by: phase-03-videos/TD-10
  - id: MD-1
    status: resolved
    summary: "No TD decides who may stream/download/read a video"
    resolved_by: phase-03-videos/TD-11
  - id: DG-1
    status: resolved
    summary: "Phase 02 exposes no lookup of the caller's channel by user id"
    resolved_by: clarification (planned in phase 03 — ChannelsService.findByUserId)
  - id: ICC-1
    status: resolved
    summary: "Global ThrottlerGuard (10 req/min/IP) would throttle the upload handshake"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-1
    status: resolved
    summary: "TD-01 (queue technology) is pending"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 (upload protocol) is pending"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 (object storage usage) is pending"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 (worker runtime) is pending"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 (FFmpeg integration) is pending"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 (thumbnail strategy) is pending"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 (unique URL identifier) is pending"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 (streaming/download delivery) is pending"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 (status lifecycle) is pending"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 (upload limits) is pending"
    resolved_by: phase-03-videos/TD-10
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ All nine capabilities map to at least one decided TD (`## Capability Coverage` in `context.md`).

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._ TD-11, created by the `/research` rerun for MD-1, was decided in the same resolve cycle (no new OQ).

### UI Coverage Gaps

_None._ (no UI scope in this phase)

## Resolved Issues

Validation history: run 1 (commit "context e validação inicial da fase 03 (dirty)") raised 16 issues; `/research` was rerun to add TD-11 (MD-1); `/plan-resolve` decided TD-01…TD-11 and cached the libraries in `library-refs.md`; run 2 (this file) is `clean`.

- **IC-1** _(resolved_by phase-03-videos/TD-03)_ — tests use the real MinIO Compose service; `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § Object Storage revised from "Local Filesystem" to "Real MinIO (Docker)", and § Message Queue updated with the decided BullMQ + Redis stack.
- **IC-2** _(resolved_by phase-03-videos/TD-03)_ — service-to-service calls keep the Compose name (`S3_ENDPOINT=http://minio:9000`); only client-facing URLs are signed for `S3_PUBLIC_ENDPOINT=http://minio.localhost:9000`, reachable from the host (`*.localhost` → loopback, port 9000 published) and from containers (network alias `minio.localhost`, checked on the dev host with `dns.lookup` from the `nestjs-api` container).
- **AMB-1** _(resolved_by phase-03-videos/TD-10)_ — the limit is 10 GiB = 10,737,418,240 bytes.
- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — ready videos are readable (metadata/stream/download/thumbnail) by anyone holding the unique URL; draft/processing/failed answer 404 to non-owners; the owner uses the authenticated status endpoint.
- **DG-1** _(clarification)_ — the plan adds `ChannelsService.findByUserId()` to `ChannelsModule` (channels domain owns the lookup; `VideosModule` consumes it).
- **ICC-1** _(resolved_by phase-03-videos/TD-02)_ — `VideosController` declares `@Throttle({ default: { limit: 120, ttl: 60000 } })`; auth endpoints keep the 10 req/min policy of `phase-02-auth/TD-08`.
- **OQ-1 … OQ-10** _(resolved_by phase-03-videos/TD-01 … TD-10)_ — decisions filled in `docs/decisions/technical-decisions-phase-03-videos.md` (`status: decided`); libraries pinned in `library-refs.md`.
