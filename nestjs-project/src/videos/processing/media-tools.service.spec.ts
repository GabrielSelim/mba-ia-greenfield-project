import {
  parseProbeOutput,
  thumbnailOffsetSeconds,
} from './media-tools.service';
import { MediaToolException } from './video-processing.exceptions';

describe('parseProbeOutput', () => {
  it('should map duration, container, video and audio streams', () => {
    const raw = JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '12.480000',
        bit_rate: '4500000',
      },
    });

    expect(parseProbeOutput(raw)).toEqual({
      durationSeconds: 12.48,
      hasVideoStream: true,
      metadata: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        bit_rate: 4500000,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        frame_rate: 29.97,
        audio_codec: 'aac',
      },
    });
  });

  it('should fall back to r_frame_rate and the stream duration', () => {
    const raw = JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp9',
          avg_frame_rate: '0/0',
          r_frame_rate: '25/1',
          duration: '3.04',
        },
      ],
      format: { format_name: 'matroska,webm' },
    });

    const result = parseProbeOutput(raw);

    expect(result.durationSeconds).toBe(3.04);
    expect(result.metadata.frame_rate).toBe(25);
    expect(result.metadata.audio_codec).toBeNull();
    expect(result.metadata.bit_rate).toBeNull();
  });

  it('should flag files without a video stream (cover art does not count)', () => {
    const raw = JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'mp3' },
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
        },
      ],
      format: { format_name: 'mp3', duration: '180.0' },
    });

    const result = parseProbeOutput(raw);

    expect(result.hasVideoStream).toBe(false);
    expect(result.metadata.video_codec).toBeNull();
  });
});

describe('thumbnailOffsetSeconds', () => {
  it.each([
    [null, 0],
    [0.5, 0],
    [3, 0.3],
    [60, 6],
    [3600, 10],
  ])('duration %p → offset %p', (duration, expected) => {
    expect(thumbnailOffsetSeconds(duration)).toBeCloseTo(expected);
  });
});

describe('MediaToolException', () => {
  it('should classify unreadable input from the ffprobe stderr', () => {
    expect(
      new MediaToolException(
        'ffprobe',
        'http://minio:9000/x: Invalid data found when processing input',
      ).invalidInput,
    ).toBe(true);
    expect(
      new MediaToolException('ffprobe', 'Connection refused').invalidInput,
    ).toBe(false);
  });
});
