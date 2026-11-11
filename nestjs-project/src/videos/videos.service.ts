import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
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
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
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
