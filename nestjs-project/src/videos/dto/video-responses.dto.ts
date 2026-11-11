import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', description: 'Unique URL id' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;
}

export class UploadInstructionsDto {
  @ApiProperty({ description: 'Bytes per part (last part may be smaller)' })
  part_size: number;

  @ApiProperty({ description: 'Number of parts the file must be split into' })
  part_count: number;

  @ApiProperty({ description: 'Max part numbers per sign request' })
  max_parts_per_request: number;
}

export class VideoDraftResponseDto extends VideoSummaryDto {
  @ApiProperty({ type: UploadInstructionsDto })
  upload: UploadInstructionsDto;
}

export class SignedUploadPartDto {
  @ApiProperty()
  part_number: number;

  @ApiProperty({
    description:
      'Presigned PUT URL on the object storage — send the raw part bytes and keep the ETag response header',
  })
  url: string;
}

export class SignedUploadPartsDto {
  @ApiProperty({ type: [SignedUploadPartDto] })
  parts: SignedUploadPartDto[];

  @ApiProperty({ description: 'Seconds until the URLs expire' })
  expires_in: number;
}

export class VideoMetadataDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  format_name: string | null;

  @ApiProperty({ type: Number, nullable: true })
  bit_rate: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frame_rate: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;
}

export class VideoChannelDto {
  @ApiProperty()
  nickname: string;

  @ApiProperty()
  name: string;
}

export class PublicVideoDto extends VideoSummaryDto {
  @ApiProperty({ type: Number, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({
    description: 'API URL — redirects (302) to the streamable file',
  })
  stream_url: string;

  @ApiProperty({ description: 'API URL — redirects (302) to a download' })
  download_url: string;

  @ApiProperty({
    description: 'API URL — redirects (302) to the JPEG thumbnail',
  })
  thumbnail_url: string;
}

export class VideoStatusDto {
  @ApiProperty()
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ type: Number, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: String, nullable: true })
  processing_error: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processed_at: Date | null;
}
