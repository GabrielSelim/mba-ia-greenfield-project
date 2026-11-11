import { randomBytes } from 'node:crypto';

export const VIDEO_SLUG_LENGTH = 11;

/**
 * Unique public identifier of a video (technical-decisions-phase-03-videos TD-07):
 * 8 random bytes → 11 base64url chars (64 bits, URL-safe, not enumerable).
 * Uniqueness is guaranteed by the `videos.slug` unique index; callers retry
 * on collision.
 */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
