import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageUploadRejectedException } from './storage.exceptions';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;
const URL_TTL = 300;

/**
 * Runs against the real `minio` Compose service. Client-facing URLs are signed
 * for S3_PUBLIC_ENDPOINT (minio.localhost), which resolves inside the
 * container through the Compose network alias — exactly the URL a browser on
 * the host would receive.
 */
describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  const newKey = () => {
    const key = `test/${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  async function putPart(url: string, body: Buffer): Promise<string> {
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    await moduleRef.close();
  });

  it('should assemble a 2-part upload sent through public presigned URLs', async () => {
    const key = newKey();
    const part1 = randomBytes(5 * MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const url1 = await storage.presignUploadPart(key, uploadId, 1, URL_TTL);
    const url2 = await storage.presignUploadPart(key, uploadId, 2, URL_TTL);
    expect(new URL(url1).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );
    const etag1 = await putPart(url1, part1);
    const etag2 = await putPart(url2, part2);

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    const info = await storage.headObject(key);
    expect(info).toEqual({
      contentLength: part1.length + part2.length,
      contentType: 'video/mp4',
    });
  });

  it('should throw StorageUploadRejectedException when an ETag does not match', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, URL_TTL);
    await putPart(url, randomBytes(1024));

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(StorageUploadRejectedException);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('should make a part URL unusable after the upload is aborted', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, URL_TTL);

    await storage.abortMultipartUpload(key, uploadId);
    // Idempotent: aborting again is a no-op (NoSuchUpload swallowed).
    await expect(
      storage.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();

    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(16)),
    });
    expect(res.status).toBe(404);
  });

  it('should answer Range requests with 206 on a public presigned GET URL', async () => {
    const key = newKey();
    const body = randomBytes(4096);
    await storage.putObject(key, body, 'video/mp4');

    const url = await storage.presignGetObject(key, {
      expiresIn: URL_TTL,
      audience: 'public',
      contentType: 'video/mp4',
    });
    const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-99/${body.length}`);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body.subarray(0, 100));
  });

  it('should apply ResponseContentDisposition on a presigned GET URL', async () => {
    const key = newKey();
    await storage.putObject(key, randomBytes(32), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      expiresIn: URL_TTL,
      audience: 'internal',
      contentDisposition: 'attachment; filename="clip.mp4"',
    });
    expect(new URL(url).host).toBe(new URL(process.env.S3_ENDPOINT!).host);
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
  });

  it('should return null from headObject for a missing key and delete objects', async () => {
    const key = newKey();
    await storage.putObject(key, Buffer.from('x'), 'text/plain');
    expect(await storage.headObject(key)).not.toBeNull();

    await storage.deleteObject(key);

    expect(await storage.headObject(key)).toBeNull();
  });
});
