import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { thumbnailKey } from '../video-storage-keys';
import { PROCESSING_ERROR_MAX_LENGTH } from '../videos.constants';
import {
  MediaToolsService,
  ProbeResult,
  thumbnailOffsetSeconds,
} from './media-tools.service';
import {
  InvalidVideoMediaException,
  MediaToolException,
  SourceObjectMissingException,
} from './video-processing.exceptions';

export const THUMBNAIL_WIDTH = 1280;

export type ProcessingOutcome = 'processed' | 'skipped';

/**
 * Worker-side processing of an uploaded video (technical-decisions-phase-03-videos
 * TD-05, TD-06, TD-09). Idempotent: only videos in `processing` are touched,
 * and the final transitions are conditional updates.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly mediaTools: MediaToolsService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async processVideo(videoId: string): Promise<ProcessingOutcome> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return 'skipped';
    }

    const stored = await this.storage.headObject(video.storage_key);
    if (!stored) throw new SourceObjectMissingException(video.storage_key);

    // Internal URL: FFmpeg runs inside the Compose network.
    const sourceUrl = await this.storage.presignGetObject(video.storage_key, {
      expiresIn: this.config.urlTtlSeconds,
      audience: 'internal',
    });

    const probe = await this.probe(sourceUrl);
    if (!probe.hasVideoStream) {
      throw new InvalidVideoMediaException('no video stream found');
    }

    const frame = await this.mediaTools.extractFrame(
      sourceUrl,
      thumbnailOffsetSeconds(probe.durationSeconds),
      THUMBNAIL_WIDTH,
    );
    const thumbnail = thumbnailKey(video.id);
    await this.storage.putObject(thumbnail, frame, 'image/jpeg');

    const result = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: probe.durationSeconds,
        metadata: probe.metadata,
        thumbnail_key: thumbnail,
        processing_error: null,
        processed_at: new Date(),
      },
    );
    if (!result.affected) {
      this.logger.warn(`Video ${video.id} left processing concurrently`);
      return 'skipped';
    }
    this.logger.log(
      `Video ${video.id} ready (${probe.durationSeconds ?? '?'} s, ${probe.metadata.width}x${probe.metadata.height})`,
    );
    return 'processed';
  }

  /** Terminal failure: `processing → failed` with the reason. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        processing_error: reason.slice(0, PROCESSING_ERROR_MAX_LENGTH),
        processed_at: new Date(),
      },
    );
  }

  private async probe(sourceUrl: string): Promise<ProbeResult> {
    try {
      return await this.mediaTools.probe(sourceUrl);
    } catch (error) {
      if (error instanceof MediaToolException && error.invalidInput) {
        throw new InvalidVideoMediaException(error.detail);
      }
      throw error;
    }
  }
}
