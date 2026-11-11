import { Job, UnrecoverableError } from 'bullmq';
import { ProcessVideoJobData } from '../../queue/queue.constants';
import {
  InvalidVideoMediaException,
  MediaToolException,
  SourceObjectMissingException,
} from './video-processing.exceptions';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

function job(attemptsMade: number, attempts = 3): Job<ProcessVideoJobData> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  const processing = { processVideo: jest.fn(), markFailed: jest.fn() };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    jest.resetAllMocks();
    processor = new VideoProcessingProcessor(
      processing as unknown as VideoProcessingService,
    );
  });

  describe('process', () => {
    it('should delegate to the processing service', async () => {
      processing.processVideo.mockResolvedValue('processed');

      await expect(processor.process(job(0))).resolves.toBe('processed');
      expect(processing.processVideo).toHaveBeenCalledWith('video-1');
    });

    it.each([
      new InvalidVideoMediaException('no video stream found'),
      new SourceObjectMissingException('videos/video-1/original'),
    ])('should convert %p into an UnrecoverableError', async (error) => {
      processing.processVideo.mockRejectedValue(error);

      await expect(processor.process(job(0))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('should rethrow transient errors untouched so BullMQ retries', async () => {
      const transient = new MediaToolException('ffprobe', 'timed out');
      processing.processVideo.mockRejectedValue(transient);

      await expect(processor.process(job(0))).rejects.toBe(transient);
    });
  });

  describe('onFailed', () => {
    it('should not mark failed while attempts remain', async () => {
      await processor.onFailed(job(1), new Error('timed out'));

      expect(processing.markFailed).not.toHaveBeenCalled();
    });

    it('should mark failed after the last attempt', async () => {
      await processor.onFailed(job(3), new Error('timed out'));

      expect(processing.markFailed).toHaveBeenCalledWith(
        'video-1',
        'timed out',
      );
    });

    it('should mark failed immediately on an unrecoverable error', async () => {
      await processor.onFailed(job(1), new UnrecoverableError('not a video'));

      expect(processing.markFailed).toHaveBeenCalledWith(
        'video-1',
        'not a video',
      );
    });

    it('should log (not throw) when marking as failed fails', async () => {
      processing.markFailed.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(job(3), new Error('timed out')),
      ).resolves.toBeUndefined();
    });
  });
});
