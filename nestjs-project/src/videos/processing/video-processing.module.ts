import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { StorageModule } from '../../storage/storage.module';
import { UsersModule } from '../../users/users.module';
import { Video } from '../entities/video.entity';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/** Consumer side of the video pipeline — imported only by `WorkerModule`. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Registers the rest of the entity graph reachable from Video
    // (Video → Channel → User) through their owning modules; without it the
    // worker process cannot build the TypeORM metadata.
    UsersModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [
    VideoProcessingProcessor,
    VideoProcessingService,
    MediaToolsService,
  ],
})
export class VideoProcessingModule {}
