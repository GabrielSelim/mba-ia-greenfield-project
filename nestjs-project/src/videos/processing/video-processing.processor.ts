import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import {
  InvalidVideoMediaException,
  SourceObjectMissingException,
} from './video-processing.exceptions';
import {
  ProcessingOutcome,
  VideoProcessingService,
} from './video-processing.service';

/**
 * BullMQ consumer of `video-processing` — registered only in the worker
 * process (`WorkerModule`), never in the API (technical-decisions-phase-03-videos TD-04).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<ProcessingOutcome> {
    try {
      return await this.processing.processVideo(job.data.videoId);
    } catch (error) {
      if (
        error instanceof InvalidVideoMediaException ||
        error instanceof SourceObjectMissingException
      ) {
        // Permanent: skip the remaining attempts.
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /**
   * Background context: errors are logged, never rethrown (rethrowing here
   * would only crash the worker — see `.claude/rules/nestjs-services.md`).
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const isFinal =
      error.name === UnrecoverableError.name || job.attemptsMade >= attempts;
    if (!isFinal) {
      this.logger.warn(
        `Video ${job.data.videoId}: attempt ${job.attemptsMade}/${attempts} failed (${error.message}); will retry`,
      );
      return;
    }
    try {
      await this.processing.markFailed(job.data.videoId, error.message);
      this.logger.error(
        `Video ${job.data.videoId} marked as failed: ${error.message}`,
      );
    } catch (markError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
  }
}
