import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TestVideoOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** x264 target bitrate, e.g. '500k' or '30M' (bigger file). */
  bitrate?: string;
  withAudio?: boolean;
}

/**
 * Generates an MP4 with FFmpeg's synthetic sources (no binary fixtures in
 * the repository). Requires the `ffmpeg` binary of the dev image.
 */
export async function generateTestVideo(
  options: TestVideoOptions = {},
): Promise<Buffer> {
  const {
    durationSeconds = 3,
    width = 320,
    height = 240,
    bitrate = '500k',
    withAudio = true,
  } = options;
  const output = join(tmpdir(), `streamtube-test-${randomUUID()}.mp4`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=25,noise=alls=40:allf=t`,
    ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440'] : []),
    '-t',
    String(durationSeconds),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    bitrate,
    '-minrate',
    bitrate,
    '-maxrate',
    bitrate,
    '-bufsize',
    bitrate,
    ...(withAudio ? ['-c:a', 'aac'] : []),
    '-movflags',
    '+faststart',
    '-y',
    output,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with ${code}: ${stderr}`)),
    );
  });
  try {
    return await readFile(output);
  } finally {
    await rm(output, { force: true });
  }
}
