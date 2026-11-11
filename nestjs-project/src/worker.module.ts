import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import videoConfig from './config/video.config';
import { typeOrmOptionsFactory } from './database/typeorm-options';
import { QueueModule } from './queue/queue.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/**
 * Root module of the video worker process (`src/worker.ts`) — no HTTP layer.
 * Same config validation, database and queue wiring as the API
 * (technical-decisions-phase-03-videos TD-04).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        storageConfig,
        queueConfig,
        videoConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: typeOrmOptionsFactory,
    }),
    QueueModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
