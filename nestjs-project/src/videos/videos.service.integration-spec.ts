import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createChannelOwner,
  createVideosTestingModule,
} from '../test/videos-test-module';
import { Video, VideoStatus } from './entities/video.entity';
import {
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from './videos.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await createVideosTestingModule([VideosModule], {
      partSizeBytes: 5 * MIB,
    });
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function uploadIdOf(videoId: string): Promise<string> {
    const row = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id: videoId })
      .getOneOrFail();
    return row.upload_id!;
  }

  describe('createDraft', () => {
    it('should persist a draft and open a usable multipart upload in MinIO', async () => {
      const { user, channel } = await createChannelOwner(dataSource);

      const draft = await service.createDraft(user.id, {
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 12 * MIB,
      });

      const row = await videoRepository.findOneByOrFail({ id: draft.id });
      expect(row).toMatchObject({
        channel_id: channel.id,
        slug: draft.slug,
        status: VideoStatus.DRAFT,
        title: 'clip',
        storage_key: `videos/${draft.id}/original`,
        size_bytes: 12 * MIB,
      });
      expect(draft.upload).toEqual({
        part_size: 5 * MIB,
        part_count: 3,
        max_parts_per_request: 100,
      });

      // The stored UploadId is a real, open multipart upload.
      const uploadId = await uploadIdOf(draft.id);
      const url = await storage.presignUploadPart(
        row.storage_key,
        uploadId,
        1,
        60,
      );
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(1024)),
      });
      expect(res.status).toBe(200);
      await storage.abortMultipartUpload(row.storage_key, uploadId);
    });

    it('should give each draft a different slug', async () => {
      const { user } = await createChannelOwner(dataSource);
      const input = {
        filename: 'a.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      };

      const first = await service.createDraft(user.id, input);
      const second = await service.createDraft(user.id, input);

      expect(first.slug).not.toBe(second.slug);
      for (const draft of [first, second]) {
        await storage.abortMultipartUpload(
          `videos/${draft.id}/original`,
          await uploadIdOf(draft.id),
        );
      }
    });
  });

  /** Uploads `body` through the API-issued presigned URLs, like a client. */
  async function uploadThroughPresignedUrls(
    userId: string,
    slug: string,
    body: Buffer,
    partSize: number,
  ): Promise<{ part_number: number; etag: string }[]> {
    const partCount = Math.ceil(body.length / partSize);
    const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const { parts } = await service.signUploadParts(userId, slug, numbers);
    const uploaded: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const start = (part.part_number - 1) * partSize;
      const chunk = body.subarray(start, start + partSize);
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(chunk),
      });
      expect(res.status).toBe(200);
      uploaded.push({
        part_number: part.part_number,
        etag: res.headers.get('etag')!,
      });
    }
    return uploaded;
  }

  describe('upload handshake (real MinIO + Redis)', () => {
    it('should complete a 2-part upload, move to processing and enqueue the job', async () => {
      const { user } = await createChannelOwner(dataSource);
      const body = randomBytes(5 * MIB + 1024);
      const draft = await service.createDraft(user.id, {
        filename: 'two-parts.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length,
      });
      expect(draft.upload.part_count).toBe(2);

      const parts = await uploadThroughPresignedUrls(
        user.id,
        draft.slug,
        body,
        5 * MIB,
      );
      const result = await service.completeUpload(user.id, draft.slug, parts);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const row = await videoRepository
        .createQueryBuilder('video')
        .addSelect('video.upload_id')
        .where('video.id = :id', { id: draft.id })
        .getOneOrFail();
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      expect(await storage.headObject(row.storage_key)).toMatchObject({
        contentLength: body.length,
      });

      // The video-worker container may already be consuming it — look the
      // job up by its deterministic id instead of the waiting list.
      const job = await queue.getJob(draft.id);
      expect(job).toBeDefined();
      expect(job!.name).toBe(PROCESS_VIDEO_JOB);
      expect(job!.data).toEqual({ videoId: draft.id });
      expect(job!.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      await storage.deleteObject(row.storage_key);
    });

    it('should mark the video failed when the stored size differs from the declared one', async () => {
      const { user } = await createChannelOwner(dataSource);
      const body = randomBytes(5 * MIB + 1024);
      const draft = await service.createDraft(user.id, {
        filename: 'liar.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length + 1024, // still 2 parts
      });
      const parts = await uploadThroughPresignedUrls(
        user.id,
        draft.slug,
        body,
        5 * MIB,
      );

      await expect(
        service.completeUpload(user.id, draft.slug, parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const row = await videoRepository.findOneByOrFail({ id: draft.id });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.processing_error).toContain('does not match');
      expect(await storage.headObject(row.storage_key)).toBeNull();
      expect(await queue.getJob(draft.id)).toBeUndefined();
    });

    it('should reject a wrong ETag with UploadIncompleteException', async () => {
      const { user } = await createChannelOwner(dataSource);
      const body = randomBytes(2048);
      const draft = await service.createDraft(user.id, {
        filename: 'bad-etag.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length,
      });
      await uploadThroughPresignedUrls(user.id, draft.slug, body, 5 * MIB);

      await expect(
        service.completeUpload(user.id, draft.slug, [
          { part_number: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(UploadIncompleteException);

      const row = await videoRepository.findOneByOrFail({ id: draft.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      await service.abortUpload(user.id, draft.slug);
    });

    it('should abort: remove the draft and invalidate the part URLs', async () => {
      const { user } = await createChannelOwner(dataSource);
      const draft = await service.createDraft(user.id, {
        filename: 'abort.mp4',
        content_type: 'video/mp4',
        size_bytes: 2048,
      });
      const { parts } = await service.signUploadParts(user.id, draft.slug, [1]);

      await service.abortUpload(user.id, draft.slug);

      expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
      const res = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(16)),
      });
      expect(res.status).toBe(404);
    });

    it('should hide another user video behind VideoNotFoundException', async () => {
      const owner = await createChannelOwner(dataSource);
      const stranger = await createChannelOwner(dataSource);
      const draft = await service.createDraft(owner.user.id, {
        filename: 'mine.mp4',
        content_type: 'video/mp4',
        size_bytes: 2048,
      });

      await expect(
        service.signUploadParts(stranger.user.id, draft.slug, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await service.abortUpload(owner.user.id, draft.slug);
    });
  });
});
