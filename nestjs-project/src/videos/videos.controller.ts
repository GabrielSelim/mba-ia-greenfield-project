import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoDraftResponseDto } from './dto/video-responses.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
// The ThrottlerGuard registered by AuthModule is global (10 req/min/IP);
// the upload handshake needs more room (validation ICC-1 / TD-02).
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel, assigns its unique slug and opens a multipart upload on the object storage. The file itself is never sent to the API: request part URLs next.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created; multipart upload opened',
    type: VideoDraftResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 422,
    description: 'Declared size above the 10 GiB limit',
    schema: errorSchema,
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoDraftResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }
}
