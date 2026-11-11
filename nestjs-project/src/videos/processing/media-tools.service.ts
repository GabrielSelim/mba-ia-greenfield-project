import { spawn } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../../config/video.config';
import { VideoMetadata } from '../entities/video.entity';
import { MediaToolException } from './video-processing.exceptions';

export interface ProbeResult {
  durationSeconds: number | null;
  hasVideoStream: boolean;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}

const STDERR_TAIL_BYTES = 2048;
const MAX_THUMBNAIL_OFFSET_SECONDS = 10;

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "30000/1001" → 29.97; "0/0" → null. */
function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!denominator || !Number.isFinite(numerator)) return null;
  const fps = numerator / denominator;
  return fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/** Maps `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbeOutput(raw: string): ProbeResult {
  const output = JSON.parse(raw) as FfprobeOutput;
  const streams = output.streams ?? [];
  // Cover art in audio files is exposed as a video stream: ignore it.
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  return {
    durationSeconds:
      toNumber(output.format?.duration) ?? toNumber(video?.duration),
    hasVideoStream: !!video,
    metadata: {
      format_name: output.format?.format_name ?? null,
      bit_rate: toNumber(output.format?.bit_rate),
      width: video?.width ?? null,
      height: video?.height ?? null,
      video_codec: video?.codec_name ?? null,
      frame_rate:
        parseFrameRate(video?.avg_frame_rate) ??
        parseFrameRate(video?.r_frame_rate),
      audio_codec: audio?.codec_name ?? null,
    },
  };
}

/**
 * Thumbnail frame position (technical-decisions-phase-03-videos TD-06):
 * 10% of the duration, capped at 10 s; start of the video when unknown/short.
 */
export function thumbnailOffsetSeconds(duration: number | null): number {
  if (duration === null || duration < 1) return 0;
  return Math.min(duration * 0.1, MAX_THUMBNAIL_OFFSET_SECONDS);
}

/**
 * Thin wrapper over the `ffprobe`/`ffmpeg` binaries of the image
 * (technical-decisions-phase-03-videos TD-05). Inputs are HTTP(S) URLs —
 * presigned storage URLs — so FFmpeg reads only the byte ranges it needs.
 */
@Injectable()
export class MediaToolsService {
  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async probe(input: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);
    return parseProbeOutput(stdout.toString('utf8'));
  }

  /** Returns a single JPEG frame scaled to `width` (height keeps the ratio). */
  async extractFrame(
    input: string,
    offsetSeconds: number,
    width: number,
  ): Promise<Buffer> {
    const frame = await this.run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      offsetSeconds.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (frame.length === 0) {
      throw new MediaToolException('ffmpeg', 'no frame was produced');
    }
    return frame;
  }

  private run(tool: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = '';
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(Buffer.concat(stdout));
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(
          new MediaToolException(
            tool,
            `timed out after ${this.config.ffmpegTimeoutMs} ms`,
          ),
        );
      }, this.config.ffmpegTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.on('error', (error) =>
        finish(new MediaToolException(tool, error.message)),
      );
      child.on('close', (code) => {
        if (code === 0) finish(null);
        else
          finish(
            new MediaToolException(
              tool,
              stderr.trim() || `exited with code ${code}`,
            ),
          );
      });
    });
  }
}
