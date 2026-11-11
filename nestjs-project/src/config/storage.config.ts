import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  /** Service-to-service endpoint (Compose service name). */
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  /** Host used only to sign URLs handed to clients (browser, curl, player). */
  publicEndpoint:
    process.env.S3_PUBLIC_ENDPOINT || 'http://minio.localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY!,
  secretAccessKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
}));
