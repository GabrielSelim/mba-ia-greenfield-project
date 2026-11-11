import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from './videos/processing/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the processor and no HTTP controllers', async () => {
    // compile() does not run onModuleInit, so no BullMQ worker is started.
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    const controllers = [...moduleRef.get(ModulesContainer).values()].flatMap(
      (module) => [...module.controllers.keys()],
    );
    expect(controllers).toHaveLength(0);
    await moduleRef.close();
  }, 30000);
});
