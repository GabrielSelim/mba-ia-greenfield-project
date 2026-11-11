import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Video worker entrypoint: a Nest application context (no HTTP server) that
 * consumes the `video-processing` queue. Runs in the `video-worker` Compose
 * service — `npm run start:worker:dev` (watch) or `npm run start:worker`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('VideoWorker').log(
    'Video worker ready — consuming the video-processing queue',
  );
}

void bootstrap();
