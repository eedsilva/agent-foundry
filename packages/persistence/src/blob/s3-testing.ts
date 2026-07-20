import { execSync } from 'node:child_process';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe } from 'vitest';
import { S3BlobStore } from './s3-blob-store.js';

export const MINIO_BUCKET = 'test-bucket';
export const MINIO_CREDENTIALS = { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };
const MINIO_REGION = 'us-east-1';

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface MinioContext {
  store: () => S3BlobStore;
  endpoint: () => string;
}

/**
 * Skips via describe.skip when Docker is unavailable locally; throws at module
 * load if CI is set and Docker is still unavailable, so the suite can't
 * silently go green in CI. Self-contained copy of the Docker-skip policy used
 * by the Postgres testcontainers harness on the sibling branch.
 */
export function describeMinio(name: string, fn: (ctx: MinioContext) => void): void {
  if (!dockerAvailable()) {
    if (process.env.CI) {
      throw new Error(
        `describeMinio(${name}): Docker is required in CI but \`docker info\` failed`,
      );
    }
    describe.skip(`${name} (skipped: Docker unavailable)`, () => {
      fn({
        store: () => {
          throw new Error('describeMinio: store() is unreachable when Docker is unavailable');
        },
        endpoint: () => {
          throw new Error('describeMinio: endpoint() is unreachable when Docker is unavailable');
        },
      });
    });
    return;
  }

  describe(name, () => {
    let container: StartedTestContainer;
    let endpoint: string;

    beforeAll(async () => {
      container = await new GenericContainer('minio/minio:latest')
        .withCommand(['server', '/data'])
        .withEnvironment({
          MINIO_ROOT_USER: MINIO_CREDENTIALS.accessKeyId,
          MINIO_ROOT_PASSWORD: MINIO_CREDENTIALS.secretAccessKey,
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

      const setupClient = new S3Client({
        endpoint,
        region: MINIO_REGION,
        forcePathStyle: true,
        credentials: MINIO_CREDENTIALS,
      });
      try {
        await setupClient.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
      } finally {
        setupClient.destroy();
      }
    }, 120_000);

    afterAll(async () => {
      await container?.stop();
    });

    fn({
      store: () =>
        new S3BlobStore({
          endpoint,
          region: MINIO_REGION,
          bucket: MINIO_BUCKET,
          forcePathStyle: true,
          ...MINIO_CREDENTIALS,
        }),
      endpoint: () => endpoint,
    });
  });
}
