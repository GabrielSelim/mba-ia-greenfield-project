/** Accepted declared MIME types (technical-decisions-phase-03-videos TD-10). */
export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

/** Max part URLs signed per `POST /videos/{slug}/upload-parts` call. */
export const MAX_PARTS_PER_SIGN_REQUEST = 100;

/** S3 multipart hard limit. */
export const MAX_MULTIPART_PARTS = 10_000;

export const TITLE_MAX_LENGTH = 100;

export const FILENAME_MAX_LENGTH = 255;

export const MAX_SLUG_ATTEMPTS = 5;

export const PROCESSING_ERROR_MAX_LENGTH = 1000;
