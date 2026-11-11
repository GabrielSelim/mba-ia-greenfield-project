import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageUploadRejectedException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
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
  const queryBuilder = {
    addSelect: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getOne: jest.fn(),
  };
  const repository = {
    create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const manager = { update: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const queue = { add: jest.fn() };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
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
    repository.createQueryBuilder.mockReturnValue(queryBuilder);
    queryBuilder.addSelect.mockReturnValue(queryBuilder);
    queryBuilder.innerJoin.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    dataSource.transaction.mockImplementation(
      (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: DataSource, useValue: dataSource },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
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

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      slug: 'abcdefghijk',
      title: 'clip',
      status: VideoStatus.DRAFT,
      size_bytes: 250 * MIB, // 3 parts of 100 MiB
      content_type: 'video/mp4',
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
      created_at: new Date('2026-11-11T12:00:00Z'),
      ...overrides,
    } as Video;
  }

  const allParts = [
    { part_number: 2, etag: '"b"' },
    { part_number: 1, etag: '"a"' },
    { part_number: 3, etag: '"c"' },
  ];

  describe('ownership and status guards', () => {
    it('should throw VideoNotFoundException for an unknown or foreign slug', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await expect(
        service.signUploadParts('user-1', 'nope', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'channel.user_id = :userId',
        { userId: 'user-1' },
      );
    });

    it.each([
      ['sign', (svc: VideosService) => svc.signUploadParts('u', 's', [1])],
      [
        'complete',
        (svc: VideosService) => svc.completeUpload('u', 's', allParts),
      ],
      ['abort', (svc: VideosService) => svc.abortUpload('u', 's')],
    ])(
      'should reject %s when the video is no longer a draft',
      async (_name, call) => {
        queryBuilder.getOne.mockResolvedValue(
          draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
        );

        await expect(call(service)).rejects.toBeInstanceOf(
          VideoNotInDraftException,
        );
      },
    );
  });

  describe('signUploadParts', () => {
    it('should presign each requested part with the configured TTL', async () => {
      queryBuilder.getOne.mockResolvedValue(draftVideo());
      storage.presignUploadPart.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      );

      const result = await service.signUploadParts(
        'user-1',
        'abcdefghijk',
        [1, 3],
      );

      expect(result).toEqual({
        parts: [
          { part_number: 1, url: 'https://storage/part-1' },
          { part_number: 3, url: 'https://storage/part-3' },
        ],
        expires_in: 3600,
      });
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        3,
        3600,
      );
    });

    it('should reject part numbers above the part count', async () => {
      queryBuilder.getOne.mockResolvedValue(draftVideo());

      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', [3, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    beforeEach(() => {
      queryBuilder.getOne.mockResolvedValue(draftVideo());
      storage.headObject.mockResolvedValue({ contentLength: 250 * MIB });
      manager.update.mockResolvedValue({ affected: 1 });
    });

    it.each([
      ['a missing part', allParts.slice(0, 2)],
      [
        'a duplicated part',
        [...allParts.slice(0, 2), { part_number: 2, etag: '"x"' }],
      ],
      ['a gap', [...allParts.slice(0, 2), { part_number: 4, etag: '"d"' }]],
    ])('should reject a part list with %s', async (_name, parts) => {
      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should send the parts sorted, move to processing and enqueue the job', async () => {
      const result = await service.completeUpload(
        'user-1',
        'abcdefghijk',
        allParts,
      );

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 2, etag: '"b"' },
          { partNumber: 3, etag: '"c"' },
        ],
      );
      expect(manager.update).toHaveBeenCalledWith(
        Video,
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(queue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'video-1' },
        expect.objectContaining({
          jobId: 'video-1',
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('should translate a storage rejection into UploadIncompleteException', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new StorageUploadRejectedException('InvalidPart', 'bad etag'),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', allParts),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should mark the video failed and delete the object on a size mismatch', async () => {
      storage.headObject.mockResolvedValue({ contentLength: 250 * MIB - 1 });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          upload_id: null,
          processing_error: expect.stringContaining('does not match'),
        }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should propagate a queue failure so the status update rolls back', async () => {
      const failure = new Error('redis down');
      queue.add.mockRejectedValue(failure);

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', allParts),
      ).rejects.toBe(failure);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('should not enqueue when another request already completed the upload', async () => {
      manager.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', allParts),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and delete the draft', async () => {
      queryBuilder.getOne.mockResolvedValue(draftVideo());

      await service.abortUpload('user-1', 'abcdefghijk');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({
        id: 'video-1',
        status: VideoStatus.DRAFT,
      });
    });
  });
});
