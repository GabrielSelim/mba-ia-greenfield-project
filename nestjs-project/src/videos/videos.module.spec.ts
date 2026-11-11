import { getQueueToken } from '@nestjs/bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { createVideosTestingModule } from '../test/videos-test-module';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile with its imports and expose the producer queue', async () => {
    const moduleRef = await createVideosTestingModule([VideosModule]);

    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    await moduleRef.close();
  }, 30000);
});
