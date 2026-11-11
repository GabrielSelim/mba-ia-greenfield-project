import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  describe('videos (phase 03)', () => {
    const videoOperations: Array<{
      path: string;
      method: string;
      protected: boolean;
    }> = [
      { path: '/videos', method: 'post', protected: true },
      { path: '/videos/{slug}/upload-parts', method: 'post', protected: true },
      {
        path: '/videos/{slug}/complete-upload',
        method: 'post',
        protected: true,
      },
      { path: '/videos/{slug}/upload', method: 'delete', protected: true },
      { path: '/videos/{slug}/status', method: 'get', protected: true },
      { path: '/videos/{slug}', method: 'get', protected: false },
      { path: '/videos/{slug}/stream', method: 'get', protected: false },
      { path: '/videos/{slug}/download', method: 'get', protected: false },
      { path: '/videos/{slug}/thumbnail', method: 'get', protected: false },
    ];

    it('exports the 9 video operations with a summary', () => {
      const paths = document.paths as Record<
        string,
        Record<string, Record<string, unknown>>
      >;

      for (const { path, method } of videoOperations) {
        const operation = paths[path]?.[method];
        expect(operation).toBeDefined();
        expect((operation.summary as string).length).toBeGreaterThan(0);
        expect(operation.tags).toEqual(['videos']);
      }
    });

    it('declares bearer security only on owner routes', () => {
      const paths = document.paths as Record<
        string,
        Record<string, Record<string, unknown>>
      >;

      for (const { path, method, protected: isProtected } of videoOperations) {
        const security = paths[path][method].security as
          | Array<Record<string, unknown>>
          | undefined;
        const hasBearer = !!security?.some((req) => 'access-token' in req);
        expect({ path, method, hasBearer }).toEqual({
          path,
          method,
          hasBearer: isProtected,
        });
      }
    });

    it('documents the 302 redirect of the stream route', () => {
      const paths = document.paths as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >;

      expect(paths['/videos/{slug}/stream'].get.responses['302']).toBeDefined();
    });
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });
});
