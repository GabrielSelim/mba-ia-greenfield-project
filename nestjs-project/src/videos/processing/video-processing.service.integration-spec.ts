import { randomBytes, randomUUID } from 'node:crypto';
import { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { generateTestVideo } from '../../test/test-media';
import {
  createChannelOwner,
  createVideosTestingModule,
} from '../../test/videos-test-module';
import { Video, VideoStatus } from '../entities/video.entity';
import { originalVideoKey, thumbnailKey } from '../video-storage-keys';
import { MediaToolsService } from './media-tools.service';
import { InvalidVideoMediaException } from './video-processing.exceptions';
import { VideoProcessingService } from './video-processing.service';

/**
 * Real DB + MinIO + FFmpeg. The BullMQ processor is deliberately NOT part of
 * this module: it would start consuming the shared queue inside the test.
 */
describe('VideoProcessingService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  const keys: string[] = [];

  async function processingVideoWith(body: Buffer): Promise<Video> {
    const { channel } = await createChannelOwner(dataSource);
    const id = randomUUID();
    const video = videoRepository.create({
      id,
      channel_id: channel.id,
      slug: randomBytes(8).toString('base64url'),
      title: 'processing test',
      status: VideoStatus.PROCESSING,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: originalVideoKey(id),
    });
    await videoRepository.insert(video);
    await storage.putObject(video.storage_key, body, 'video/mp4');
    keys.push(video.storage_key, thumbnailKey(id));
    return video;
  }

  beforeAll(async () => {
    moduleRef = await createVideosTestingModule(
      [TypeOrmModule.forFeature([Video]), StorageModule],
      {},
      [VideoProcessingService, MediaToolsService],
    );
    service = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await Promise.all(keys.map((key) => storage.deleteObject(key)));
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('should extract duration/metadata, store a thumbnail and mark ready', async () => {
    const video = await processingVideoWith(await generateTestVideo());

    await expect(service.processVideo(video.id)).resolves.toBe('processed');

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeCloseTo(3, 0);
    expect(row.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(row.thumbnail_key).toBe(thumbnailKey(video.id));
    expect(row.processed_at).toBeInstanceOf(Date);
    expect(await storage.headObject(thumbnailKey(video.id))).toMatchObject({
      contentType: 'image/jpeg',
    });
  }, 60000);

  it('should be idempotent: a second run is skipped', async () => {
    const video = await processingVideoWith(await generateTestVideo());
    await service.processVideo(video.id);

    await expect(service.processVideo(video.id)).resolves.toBe('skipped');
  }, 60000);

  it('should reject a non-video upload and markFailed records the reason', async () => {
    const video = await processingVideoWith(randomBytes(64 * 1024));

    const error = await service.processVideo(video.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidVideoMediaException);
    await service.markFailed(video.id, (error as Error).message);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.processing_error).toContain('not a playable video');
    expect(row.thumbnail_key).toBeNull();
  }, 60000);
});
