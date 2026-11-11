import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const config = {
  maxSizeBytes: 10 * GIB,
  partSizeBytes: 100 * MIB,
  urlTtlSeconds: 3600,
  processingAttempts: 3,
  processingBackoffMs: 5000,
  ffmpegTimeoutMs: 300000,
};

function slugCollision(): QueryFailedError {
  return new QueryFailedError(
    'INSERT INTO "videos"',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (slug)=(abc) already exists.',
    }),
  );
}

describe('VideosService', () => {
  let service: VideosService;
  const repository = {
    create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
    insert: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };

  const dto: CreateVideoDto = {
    filename: 'Summer Trip.mp4',
    content_type: 'video/mp4',
    size_bytes: 250 * MIB,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    repository.create.mockImplementation(
      (data: Partial<Video>) => ({ ...data }) as Video,
    );
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    repository.insert.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: videoConfig.KEY, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  describe('createDraft', () => {
    it('should throw ChannelNotFoundException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft('user-1', dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject sizes above the 10 GiB limit without touching storage', async () => {
      await expect(
        service.createDraft('user-1', { ...dto, size_bytes: 10 * GIB + 1 }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should accept exactly 10 GiB and split it into 103 parts of 100 MiB', async () => {
      const result = await service.createDraft('user-1', {
        ...dto,
        size_bytes: 10 * GIB,
      });

      expect(result.upload).toEqual({
        part_size: 100 * MIB,
        part_count: 103,
        max_parts_per_request: 100,
      });
    });

    it('should compute the part count for exact multiples', async () => {
      const result = await service.createDraft('user-1', {
        ...dto,
        size_bytes: 200 * MIB,
      });

      expect(result.upload.part_count).toBe(2);
    });

    it('should persist a draft keyed by its id and default the title to the filename', async () => {
      const result = await service.createDraft('user-1', dto);

      const inserted = repository.insert.mock.calls[0][0] as Video;
      expect(inserted).toMatchObject({
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        title: 'Summer Trip',
        original_filename: 'Summer Trip.mp4',
        size_bytes: 250 * MIB,
        upload_id: 'upload-1',
      });
      expect(inserted.storage_key).toBe(`videos/${inserted.id}/original`);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        inserted.storage_key,
        'video/mp4',
      );
      expect(result.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(result.status).toBe(VideoStatus.DRAFT);
    });

    it('should keep an explicit title', async () => {
      await service.createDraft('user-1', { ...dto, title: 'My title' });

      expect((repository.insert.mock.calls[0][0] as Video).title).toBe(
        'My title',
      );
    });

    it('should retry with a new slug on a slug unique violation', async () => {
      repository.insert
        .mockRejectedValueOnce(slugCollision())
        .mockResolvedValueOnce(undefined);

      await service.createDraft('user-1', dto);

      expect(repository.insert).toHaveBeenCalledTimes(2);
      const first = repository.insert.mock.calls[0][0] as Video;
      const second = repository.insert.mock.calls[1][0] as Video;
      expect(second.slug).not.toBe(first.slug);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload when the draft cannot be persisted', async () => {
      const failure = new Error('db down');
      repository.insert.mockRejectedValue(failure);

      await expect(service.createDraft('user-1', dto)).rejects.toBe(failure);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-1',
      );
    });

    it('should give up after 5 slug collisions and abort the upload', async () => {
      repository.insert.mockRejectedValue(slugCollision());

      await expect(service.createDraft('user-1', dto)).rejects.toBeInstanceOf(
        QueryFailedError,
      );

      expect(repository.insert).toHaveBeenCalledTimes(5);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });
  });
});
