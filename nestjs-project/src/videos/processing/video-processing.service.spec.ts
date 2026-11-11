import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { MediaToolsService, ProbeResult } from './media-tools.service';
import {
  InvalidVideoMediaException,
  MediaToolException,
  SourceObjectMissingException,
} from './video-processing.exceptions';
import {
  THUMBNAIL_WIDTH,
  VideoProcessingService,
} from './video-processing.service';

const probeResult: ProbeResult = {
  durationSeconds: 60,
  hasVideoStream: true,
  metadata: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    bit_rate: 1000000,
    width: 1920,
    height: 1080,
    video_codec: 'h264',
    frame_rate: 25,
    audio_codec: 'aac',
  },
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const repository = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = {
    headObject: jest.fn(),
    presignGetObject: jest.fn(),
    putObject: jest.fn(),
  };
  const mediaTools = { probe: jest.fn(), extractFrame: jest.fn() };
  const processingVideo = {
    id: 'video-1',
    status: VideoStatus.PROCESSING,
    storage_key: 'videos/video-1/original',
  } as Video;

  beforeEach(async () => {
    jest.resetAllMocks();
    repository.findOneBy.mockResolvedValue(processingVideo);
    repository.update.mockResolvedValue({ affected: 1 });
    storage.headObject.mockResolvedValue({ contentLength: 1000 });
    storage.presignGetObject.mockResolvedValue('http://minio:9000/signed');
    mediaTools.probe.mockResolvedValue(probeResult);
    mediaTools.extractFrame.mockResolvedValue(Buffer.from([0xff, 0xd8]));

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: MediaToolsService, useValue: mediaTools },
        {
          provide: videoConfig.KEY,
          useValue: { urlTtlSeconds: 3600, ffmpegTimeoutMs: 1000 },
        },
      ],
    }).compile();
    service = moduleRef.get(VideoProcessingService);
  });

  describe('processVideo', () => {
    it.each([
      ['missing', null],
      ['ready', { ...processingVideo, status: VideoStatus.READY }],
      ['draft', { ...processingVideo, status: VideoStatus.DRAFT }],
    ])('should skip a %s video without touching storage', async (_n, row) => {
      repository.findOneBy.mockResolvedValue(row);

      await expect(service.processVideo('video-1')).resolves.toBe('skipped');
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should throw SourceObjectMissingException when the original is gone', async () => {
      storage.headObject.mockResolvedValue(null);

      await expect(service.processVideo('video-1')).rejects.toBeInstanceOf(
        SourceObjectMissingException,
      );
    });

    it('should probe through an internal presigned URL and store the results', async () => {
      await expect(service.processVideo('video-1')).resolves.toBe('processed');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
        { expiresIn: 3600, audience: 'internal' },
      );
      // 10% of 60 s = 6 s, width 1280 (TD-06)
      expect(mediaTools.extractFrame).toHaveBeenCalledWith(
        'http://minio:9000/signed',
        6,
        THUMBNAIL_WIDTH,
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        Buffer.from([0xff, 0xd8]),
        'image/jpeg',
      );
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.PROCESSING },
        expect.objectContaining({
          status: VideoStatus.READY,
          duration_seconds: 60,
          metadata: probeResult.metadata,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          processed_at: expect.any(Date),
        }),
      );
    });

    it('should turn unreadable input into InvalidVideoMediaException', async () => {
      mediaTools.probe.mockRejectedValue(
        new MediaToolException(
          'ffprobe',
          'Invalid data found when processing input',
        ),
      );

      await expect(service.processVideo('video-1')).rejects.toBeInstanceOf(
        InvalidVideoMediaException,
      );
    });

    it('should rethrow transient tool errors as-is (retryable)', async () => {
      const transient = new MediaToolException('ffprobe', 'Connection refused');
      mediaTools.probe.mockRejectedValue(transient);

      await expect(service.processVideo('video-1')).rejects.toBe(transient);
    });

    it('should reject media without a video stream', async () => {
      mediaTools.probe.mockResolvedValue({
        ...probeResult,
        hasVideoStream: false,
      });

      await expect(service.processVideo('video-1')).rejects.toBeInstanceOf(
        InvalidVideoMediaException,
      );
      expect(mediaTools.extractFrame).not.toHaveBeenCalled();
    });

    it('should report skipped when the status changed during processing', async () => {
      repository.update.mockResolvedValue({ affected: 0 });

      await expect(service.processVideo('video-1')).resolves.toBe('skipped');
    });
  });

  describe('markFailed', () => {
    it('should move processing → failed with a truncated reason', async () => {
      await service.markFailed('video-1', 'x'.repeat(5000));

      const [criteria, changes] = repository.update.mock.calls[0];
      expect(criteria).toEqual({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
      });
      expect(changes.status).toBe(VideoStatus.FAILED);
      expect(changes.processing_error).toHaveLength(1000);
    });
  });
});
