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
