import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/** Consumer side of the video pipeline — imported only by `WorkerModule`. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
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
