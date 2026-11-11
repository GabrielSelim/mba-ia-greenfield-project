import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  FILENAME_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from '../videos.constants';

export class CreateVideoDto {
  @ApiProperty({ example: 'my-trip.mp4', maxLength: FILENAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FILENAME_MAX_LENGTH)
  filename: string;

  @ApiProperty({ enum: ALLOWED_VIDEO_CONTENT_TYPES, example: 'video/mp4' })
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  content_type: string;

  @ApiProperty({
    description: 'Declared file size in bytes (max 10737418240 = 10 GiB).',
    example: 52428800,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiPropertyOptional({
    description: 'Defaults to the filename without extension.',
    maxLength: TITLE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(TITLE_MAX_LENGTH)
  title?: string;
}
