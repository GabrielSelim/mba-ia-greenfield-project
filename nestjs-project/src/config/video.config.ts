import { registerAs } from '@nestjs/config';

const MIB = 1024 * 1024;

export default registerAs('video', () => ({
  /** 10 GiB — technical-decisions-phase-03-videos TD-10 (AMB-1). */
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  partSizeBytes:
    parseInt(process.env.VIDEO_UPLOAD_PART_SIZE_MB || '100', 10) * MIB,
  urlTtlSeconds: parseInt(process.env.VIDEO_URL_TTL_SECONDS || '3600', 10),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  processingBackoffMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '5000',
    10,
  ),
  ffmpegTimeoutMs: parseInt(
    process.env.VIDEO_FFMPEG_TIMEOUT_MS || '300000',
    10,
  ),
}));
