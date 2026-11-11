import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_MULTIPART_PARTS,
  MAX_PARTS_PER_SIGN_REQUEST,
} from '../videos.constants';

export class SignUploadPartsDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3],
    description: `1 to ${MAX_PARTS_PER_SIGN_REQUEST} unique part numbers (1-based)`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_SIGN_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}

export class CompletedPartDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  part_number: number;

  @ApiProperty({
    example: '"5d41402abc4b2a76b9719d911017c592"',
    description: 'ETag response header returned by the storage for the part',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ type: [CompletedPartDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MULTIPART_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
