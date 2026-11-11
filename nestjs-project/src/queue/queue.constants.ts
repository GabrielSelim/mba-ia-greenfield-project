/** BullMQ queue consumed by the video worker (technical-decisions-phase-03-videos TD-01). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Job name of the only message of the queue — payload `ProcessVideoJobData`. */
export const PROCESS_VIDEO_JOB = 'process-video';

export interface ProcessVideoJobData {
  videoId: string;
}
