import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageUploadRejectedException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompletedPartDto } from './dto/upload-parts.dto';
import {
  SignedUploadPartsDto,
  VideoDraftResponseDto,
  VideoSummaryDto,
} from './dto/video-responses.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { originalVideoKey } from './video-storage-keys';
import { generateVideoSlug } from './video-slug.util';
import {
  MAX_MULTIPART_PARTS,
  MAX_PARTS_PER_SIGN_REQUEST,
  MAX_SLUG_ATTEMPTS,
  TITLE_MAX_LENGTH,
} from './videos.constants';
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

const PG_UNIQUE_VIOLATION = '23505';

interface PgDriverErrorFields {
  code?: string;
  detail?: string;
}

function isSlugUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error as QueryFailedError & PgDriverErrorFields;
  return code === PG_UNIQUE_VIOLATION && !!detail?.includes('slug');
}

function defaultTitle(filename: string): string {
  const name = parse(filename).name.trim() || filename.trim();
  return name.slice(0, TITLE_MAX_LENGTH);
}

export function toVideoSummary(video: Video): VideoSummaryDto {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    status: video.status,
    size_bytes: video.size_bytes,
    content_type: video.content_type,
    created_at: video.created_at,
  };
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * Pre-registers the video as `draft` and opens the S3 multipart upload
   * (technical-decisions-phase-03-videos TD-02 / TD-09). No byte of the file
   * goes through the API: the client uploads parts with presigned URLs.
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<VideoDraftResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException(this.config.maxSizeBytes);
    }
    const partCount = this.partCountFor(dto.size_bytes);

    const id = randomUUID();
    const storageKey = originalVideoKey(id);
    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title ?? defaultTitle(dto.filename),
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (error) {
      // Compensation: do not leave an orphan multipart upload behind.
      await this.storage.abortMultipartUpload(storageKey, uploadId);
      throw error;
    }

    return {
      ...toVideoSummary(video),
      upload: {
        part_size: this.config.partSizeBytes,
        part_count: partCount,
        max_parts_per_request: MAX_PARTS_PER_SIGN_REQUEST,
      },
    };
  }

  /** Presigned PUT URLs for the requested parts (TD-02). */
  async signUploadParts(
    userId: string,
    slug: string,
    partNumbers: number[],
  ): Promise<SignedUploadPartsDto> {
    const video = await this.findOwnedVideo(userId, slug);
    this.assertDraft(video);
    const partCount = this.partCountFor(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }

    const expiresIn = this.config.urlTtlSeconds;
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expires_in: expiresIn };
  }

  /**
   * Assembles the multipart upload, verifies the stored size and moves the
   * video to `processing`, enqueuing the processing job in the same
   * transaction (TD-02, TD-09, TD-10).
   */
  async completeUpload(
    userId: string,
    slug: string,
    parts: CompletedPartDto[],
  ): Promise<VideoSummaryDto> {
    const video = await this.findOwnedVideo(userId, slug);
    this.assertDraft(video);
    const partCount = this.partCountFor(video.size_bytes);
    const sorted = [...parts].sort((a, b) => a.part_number - b.part_number);
    const isExactSequence =
      sorted.length === partCount &&
      sorted.every((part, index) => part.part_number === index + 1);
    if (!isExactSequence) throw new InvalidUploadPartsException(partCount);

    try {
      await this.storage.completeMultipartUpload(
        video.storage_key,
        video.upload_id!,
        sorted.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (error instanceof StorageUploadRejectedException) {
        throw new UploadIncompleteException();
      }
      throw error;
    }

    const stored = await this.storage.headObject(video.storage_key);
    if (!stored || stored.contentLength !== video.size_bytes) {
      await this.storage.deleteObject(video.storage_key);
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          processing_error: `Uploaded size (${stored?.contentLength ?? 0} bytes) does not match the declared size (${video.size_bytes} bytes)`,
        },
      );
      throw new UploadSizeMismatchException();
    }

    await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        Video,
        { id: video.id, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      if (!result.affected) throw new VideoNotInDraftException();
      // Enqueued inside the transaction: if Redis rejects the job the status
      // change rolls back. A job left by a failed commit is harmless — the
      // worker only processes videos in `processing` (idempotent consumer).
      await this.processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        {
          jobId: video.id,
          attempts: this.config.processingAttempts,
          backoff: {
            type: 'exponential',
            delay: this.config.processingBackoffMs,
          },
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );
    });

    return toVideoSummary({ ...video, status: VideoStatus.PROCESSING });
  }

  /** Aborts the multipart upload and removes the draft. */
  async abortUpload(userId: string, slug: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, slug);
    this.assertDraft(video);
    await this.storage.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
    await this.videoRepository.delete({
      id: video.id,
      status: VideoStatus.DRAFT,
    });
  }

  /**
   * Video of the caller's channel. Unknown slug and someone else's video
   * are indistinguishable on purpose (no existence leak).
   */
  private async findOwnedVideo(userId: string, slug: string): Promise<Video> {
    const video = await this.videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .innerJoin('video.channel', 'channel')
      .where('video.slug = :slug', { slug })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private assertDraft(video: Video): void {
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotInDraftException();
    }
  }

  partCountFor(sizeBytes: number): number {
    const partCount = Math.ceil(sizeBytes / this.config.partSizeBytes);
    if (partCount > MAX_MULTIPART_PARTS) {
      // Only reachable with a misconfigured part size (Joi bounds prevent it
      // for the 10 GiB default) — surface it as a size error.
      throw new VideoTooLargeException(this.config.maxSizeBytes);
    }
    return partCount;
  }

  private async insertWithUniqueSlug(
    data: Omit<
      Video,
      | 'slug'
      | 'channel'
      | 'thumbnail_key'
      | 'duration_seconds'
      | 'metadata'
      | 'processing_error'
      | 'processed_at'
      | 'created_at'
      | 'updated_at'
    >,
  ): Promise<Video> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const video = this.videoRepository.create({
        ...data,
        slug: generateVideoSlug(),
      });
      try {
        await this.videoRepository.insert(video);
        return video;
      } catch (error) {
        if (isSlugUniqueViolation(error) && attempt < MAX_SLUG_ATTEMPTS) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unreachable: slug generation loop exhausted');
  }
}
