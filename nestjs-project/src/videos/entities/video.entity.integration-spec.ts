import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_entity_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `chan${counter}`,
        nickname: `video_entity_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channelId,
      slug: `s${counter}${Math.random().toString(36).slice(2, 8)}`.slice(0, 11),
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/original`,
      upload_id: 'upload-123',
      ...overrides,
    });
  }

  it('should default status to draft and keep the provided id', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);

    await videoRepository.insert(video);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.thumbnail_key).toBeNull();
    expect(persisted.duration_seconds).toBeNull();
    expect(persisted.created_at).toBeInstanceOf(Date);
  });

  it('should enforce a unique slug', async () => {
    const channel = await createChannel();
    await videoRepository.insert(
      buildVideo(channel.id, { slug: 'abcdefghijk' }),
    );

    await expect(
      videoRepository.insert(buildVideo(channel.id, { slug: 'abcdefghijk' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should hide upload_id unless explicitly selected', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);
    await videoRepository.insert(video);

    const byDefault = await videoRepository.findOneByOrFail({ id: video.id });
    const explicit = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id: video.id })
      .getOneOrFail();

    expect(byDefault.upload_id).toBeUndefined();
    expect(explicit.upload_id).toBe('upload-123');
  });

  it('should round-trip a 10 GiB size_bytes as a number', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, { size_bytes: 10737418240 });
    await videoRepository.insert(video);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });

    expect(persisted.size_bytes).toBe(10737418240);
  });

  it('should store metadata as jsonb', async () => {
    const channel = await createChannel();
    const metadata = {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 512000,
      width: 320,
      height: 240,
      video_codec: 'h264',
      frame_rate: 25,
      audio_codec: null,
    };
    const video = buildVideo(channel.id, {
      status: VideoStatus.READY,
      metadata,
      duration_seconds: 3.04,
    });
    await videoRepository.insert(video);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });

    expect(persisted.metadata).toEqual(metadata);
    expect(persisted.duration_seconds).toBeCloseTo(3.04);
  });

  it('should delete videos when their channel is deleted (cascade)', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);
    await videoRepository.insert(video);

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
  });
});
