import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { generateTestVideo } from '../../test/test-media';
import { MediaToolsService } from './media-tools.service';
import { MediaToolException } from './video-processing.exceptions';

/** Real ffprobe/ffmpeg reading from a presigned MinIO URL (TD-05). */
describe('MediaToolsService (integration)', () => {
  let moduleRef: TestingModule;
  let mediaTools: MediaToolsService;
  let storage: StorageService;
  const keys: string[] = [];

  async function storeAndSign(body: Buffer): Promise<string> {
    const key = `test/${randomUUID()}/original`;
    keys.push(key);
    await storage.putObject(key, body, 'video/mp4');
    return storage.presignGetObject(key, {
      expiresIn: 300,
      audience: 'internal',
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
      providers: [MediaToolsService],
    }).compile();
    mediaTools = moduleRef.get(MediaToolsService);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(keys.map((key) => storage.deleteObject(key)));
    await moduleRef.close();
  });

  it('should probe duration and metadata of a generated video over HTTP', async () => {
    const url = await storeAndSign(await generateTestVideo());

    const result = await mediaTools.probe(url);

    expect(result.hasVideoStream).toBe(true);
    expect(result.durationSeconds).toBeCloseTo(3, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      frame_rate: 25,
    });
    expect(result.metadata.format_name).toContain('mp4');
  }, 30000);

  it('should extract a JPEG frame scaled to the requested width', async () => {
    const url = await storeAndSign(await generateTestVideo());

    const frame = await mediaTools.extractFrame(url, 0.3, 640);

    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(frame.length).toBeGreaterThan(1000);
  }, 30000);

  it('should reject a non-media file with an invalid-input MediaToolException', async () => {
    const url = await storeAndSign(randomBytes(64 * 1024));

    const error = await mediaTools.probe(url).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaToolException);
    expect((error as MediaToolException).invalidInput).toBe(true);
  }, 30000);
});
