import { randomBytes } from 'node:crypto';
import { TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createChannelOwner,
  createVideosTestingModule,
} from '../test/videos-test-module';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await createVideosTestingModule([VideosModule], {
      partSizeBytes: 5 * MIB,
    });
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
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
});
