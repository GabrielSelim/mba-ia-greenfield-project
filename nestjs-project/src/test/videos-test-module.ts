import { DynamicModule, Provider, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { QueueModule } from '../queue/queue.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { createTestDataSource } from './create-test-data-source';

export const VIDEO_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

/**
 * Testing module wired to the real Compose services (db, minio, redis) with
 * the config namespaces used by the videos feature. `overrides` replaces
 * values of the `video` namespace (e.g. a 5 MiB part size for multipart tests).
 */
export async function createVideosTestingModule(
  imports: Array<Type<unknown> | DynamicModule>,
  overrides: Partial<ReturnType<typeof videoConfig>> = {},
  providers: Provider[] = [],
): Promise<TestingModule> {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [appConfig, storageConfig, queueConfig, videoConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(VIDEO_TEST_ENTITIES).options),
      QueueModule,
      ...imports,
    ],
    providers,
  });
  if (Object.keys(overrides).length > 0) {
    builder
      .overrideProvider(videoConfig.KEY)
      .useValue({ ...videoConfig(), ...overrides });
  }
  return builder.compile();
}

let ownerCounter = 0;

/** Persists a user with its channel (the shape created at registration). */
export async function createChannelOwner(
  dataSource: DataSource,
): Promise<{ user: User; channel: Channel }> {
  ownerCounter += 1;
  const tag = `${Date.now().toString(36)}${ownerCounter}`;
  const users: Repository<User> = dataSource.getRepository(User);
  const channels: Repository<Channel> = dataSource.getRepository(Channel);
  const user = await users.save(
    users.create({ email: `owner_${tag}@example.com`, password: 'hashed' }),
  );
  const channel = await channels.save(
    channels.create({
      name: `owner_${tag}`,
      nickname: `owner_${tag}`.slice(0, 50),
      user_id: user.id,
    }),
  );
  return { user, channel };
}
