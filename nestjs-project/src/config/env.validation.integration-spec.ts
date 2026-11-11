import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — Phase 03 (storage, queue, videos)', () => {
  it('should require S3_ACCESS_KEY and S3_SECRET_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_ACCESS_KEY: undefined, S3_SECRET_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should apply the Compose-oriented defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://minio.localhost:9000',
      S3_BUCKET: 'streamtube-videos',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      VIDEO_MAX_SIZE_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_MB: 100,
      VIDEO_PROCESSING_ATTEMPTS: 3,
    });
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_MB: '4' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_MB');
  });
});
