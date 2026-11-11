import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto, SignUploadPartsDto } from './dto/upload-parts.dto';
import {
  PublicVideoDto,
  SignedUploadPartsDto,
  VideoDraftResponseDto,
  VideoStatusDto,
  VideoSummaryDto,
} from './dto/video-responses.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

interface RedirectResponse {
  url: string;
  statusCode: number;
}

const redirectResponse = (description: string) =>
  ApiResponse({
    status: 302,
    description,
    headers: {
      Location: {
        description: 'Presigned object storage URL (short-lived)',
        schema: { type: 'string', format: 'uri' },
      },
    },
  });

const notReadyResponse = ApiResponse({
  status: 404,
  description: 'Unknown slug or video not ready',
  schema: errorSchema,
});

@ApiTags('videos')
@Controller('videos')
// The ThrottlerGuard registered by AuthModule is global (10 req/min/IP);
// the upload handshake needs more room (validation ICC-1 / TD-02).
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Public()
  @Get(':slug')
  @ApiParam({ name: 'slug', description: 'Unique URL id of the video' })
  @ApiOperation({
    summary: 'Get a video by its unique URL',
    description:
      'Public. Returns a ready video with its duration, metadata, channel and the stream/download/thumbnail URLs. Videos that are not ready answer 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'Ready video',
    type: PublicVideoDto,
  })
  @notReadyResponse
  findOne(@Param('slug') slug: string): Promise<PublicVideoDto> {
    return this.videosService.getPublicVideo(slug);
  }

  @Get(':slug/status')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Processing status (owner)',
    description:
      'Returns the status of one of the caller videos: draft, processing, ready or failed (with processing_error).',
  })
  @ApiResponse({
    status: 200,
    description: 'Video status',
    type: VideoStatusDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for this user',
    schema: errorSchema,
  })
  status(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoStatusDto> {
    return this.videosService.getOwnerStatus(user.sub, slug);
  }

  @Public()
  @Get(':slug/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream the video',
    description:
      'Public. Redirects to a short-lived storage URL that supports HTTP Range requests (206 Partial Content), so players start and seek without downloading the whole file.',
  })
  @redirectResponse('Redirect to the streamable file')
  @notReadyResponse
  async stream(@Param('slug') slug: string): Promise<RedirectResponse> {
    return {
      url: await this.videosService.getStreamUrl(slug),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @Get(':slug/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download the video',
    description:
      'Public. Redirects to a short-lived storage URL served with Content-Disposition: attachment and the original filename.',
  })
  @redirectResponse('Redirect to the download')
  @notReadyResponse
  async download(@Param('slug') slug: string): Promise<RedirectResponse> {
    return {
      url: await this.videosService.getDownloadUrl(slug),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @Get(':slug/thumbnail')
  @Redirect()
  @ApiOperation({
    summary: 'Video thumbnail',
    description:
      'Public. Redirects to the JPEG thumbnail generated from a frame of the video.',
  })
  @redirectResponse('Redirect to the JPEG thumbnail')
  @notReadyResponse
  async thumbnail(@Param('slug') slug: string): Promise<RedirectResponse> {
    return {
      url: await this.videosService.getThumbnailUrl(slug),
      statusCode: HttpStatus.FOUND,
    };
  }

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

  @Post(':slug/upload-parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns presigned PUT URLs (object storage) for up to 100 parts of a draft upload. The client sends each part directly to the storage and keeps the ETag response header. URLs can be requested again (e.g. after expiry or to retry a part).',
  })
  @ApiResponse({
    status: 200,
    description: 'Part URLs',
    type: SignedUploadPartsDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number above the part count',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for this user',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is no longer in progress',
    schema: errorSchema,
  })
  signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedUploadPartsDto> {
    return this.videosService.signUploadParts(user.sub, slug, dto.part_numbers);
  }

  @Post(':slug/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the uploaded parts on the storage, checks the stored size against the declared size and starts the automatic processing (status becomes processing).',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, processing queued',
    type: VideoSummaryDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part list is not exactly 1..N',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for this user',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is no longer in progress',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 422,
    description:
      'Storage rejected the parts or the stored size differs from the declared size',
    schema: errorSchema,
  })
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoSummaryDto> {
    return this.videosService.completeUpload(user.sub, slug, dto.parts);
  }

  @Delete(':slug/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort the upload',
    description:
      'Aborts the multipart upload on the storage and removes the draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for this user',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is no longer in progress',
    schema: errorSchema,
  })
  abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, slug);
  }
}
