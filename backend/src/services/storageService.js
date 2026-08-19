import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Object storage behind a small driver interface.
 *
 * Original files are kept out of PostgreSQL - the database stores only metadata
 * and the `storage_key`.
 *
 *   local : development, and single-host deployments with a mounted volume.
 *   s3    : any S3-compatible service (AWS S3, Cloudflare R2, MinIO, Spaces).
 *           Required for more than one replica, and for containers whose
 *           filesystem is ephemeral.
 *
 * The application only ever uses put/localPath/stream/delete, so swapping the
 * driver needs no changes anywhere else.
 */

/** Keys are namespaced per user so one user's prefix never contains another's. */
export function buildStorageKey(userId, originalFilename) {
  const extension = path.extname(originalFilename).toLowerCase().slice(0, 12);
  const unique = crypto.randomBytes(16).toString('hex');
  return `users/${userId}/${unique}${extension}`;
}

/* ----------------------------------------------------------------- local -- */

const localRoot = config.storage.dir;

const localPathFor = (storageKey) => {
  const resolved = path.resolve(localRoot, storageKey);
  // Defence in depth: a crafted key must never escape the storage root.
  if (!resolved.startsWith(path.resolve(localRoot))) {
    throw new Error('Invalid storage key');
  }
  return resolved;
};

const localDriver = {
  name: 'local',

  async put(storageKey, sourcePath) {
    const destination = localPathFor(storageKey);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(sourcePath, destination).catch(async (error) => {
      // rename fails across devices; fall back to copy + unlink.
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(sourcePath, destination);
      await fs.unlink(sourcePath).catch(() => {});
    });
    return storageKey;
  },

  /** Local files can be read directly by the extraction step. */
  async localPath(storageKey) {
    return localPathFor(storageKey);
  },

  async stream(storageKey) {
    return createReadStream(localPathFor(storageKey));
  },

  async delete(storageKey) {
    await fs.unlink(localPathFor(storageKey)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  },
};

/* -------------------------------------------------------------------- s3 -- */

let s3ClientPromise = null;

async function getS3() {
  if (!s3ClientPromise) {
    s3ClientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      return new S3Client({
        region: config.storage.s3.region,
        // Set for R2/MinIO/Spaces; omit for AWS S3.
        ...(config.storage.s3.endpoint ? { endpoint: config.storage.s3.endpoint } : {}),
        // Required by MinIO and most S3-compatible services.
        forcePathStyle: config.storage.s3.forcePathStyle,
        // Omitted credentials fall back to the default provider chain
        // (instance role, IRSA, ~/.aws/credentials), which is preferable to
        // static keys in production.
        ...(config.storage.s3.accessKeyId && config.storage.s3.secretAccessKey
          ? {
              credentials: {
                accessKeyId: config.storage.s3.accessKeyId,
                secretAccessKey: config.storage.s3.secretAccessKey,
              },
            }
          : {}),
      });
    })();
  }
  return s3ClientPromise;
}

const s3Driver = {
  name: 's3',

  async put(storageKey, sourcePath) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    const body = await fs.readFile(sourcePath);

    await client.send(
      new PutObjectCommand({
        Bucket: config.storage.s3.bucket,
        Key: storageKey,
        Body: body,
        ...(config.storage.s3.serverSideEncryption
          ? { ServerSideEncryption: config.storage.s3.serverSideEncryption }
          : {}),
      }),
    );

    await fs.unlink(sourcePath).catch(() => {});
    return storageKey;
  },

  /**
   * Extraction runs in the Python service and needs a real path, so the object
   * is materialised into a temp file. It is removed by the caller's cleanup or
   * by the OS temp sweep.
   */
  async localPath(storageKey) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();

    const response = await client.send(
      new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: storageKey }),
    );

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ragchat-s3-'));
    const target = path.join(directory, path.basename(storageKey));
    await fs.writeFile(target, Buffer.from(await response.Body.transformToByteArray()));
    return target;
  },

  async stream(storageKey) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    const response = await client.send(
      new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: storageKey }),
    );
    return response.Body;
  },

  async delete(storageKey) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    await client.send(
      new DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: storageKey }),
    );
  },
};

/* ---------------------------------------------------------------- shared -- */

const drivers = { local: localDriver, s3: s3Driver };

function getDriver() {
  const driver = drivers[config.storage.driver];
  if (!driver) {
    throw new Error(
      `Unknown STORAGE_DRIVER "${config.storage.driver}". Available: ${Object.keys(drivers).join(', ')}`,
    );
  }
  if (driver.name === 's3' && !config.storage.s3.bucket) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET to be set.');
  }
  return driver;
}

export const putObject = (storageKey, sourcePath) => getDriver().put(storageKey, sourcePath);
export const getObjectPath = (storageKey) => getDriver().localPath(storageKey);
export const getObjectStream = (storageKey) => getDriver().stream(storageKey);

export async function deleteObject(storageKey) {
  try {
    await getDriver().delete(storageKey);
    return true;
  } catch (error) {
    // A missing object must not block deleting the database record.
    logger.warn(`could not delete stored object ${storageKey}: ${error.message}`);
    return false;
  }
}

export const storageDriverName = () => getDriver().name;

export default {
  buildStorageKey,
  putObject,
  getObjectPath,
  getObjectStream,
  deleteObject,
  storageDriverName,
};
