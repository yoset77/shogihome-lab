import fs from "node:fs";
import path from "node:path";
import lockfile, { LockOptions } from "proper-lockfile";
import { OperationOptions } from "retry";

const lockOptions: LockOptions = {
  stale: 10000,
  realpath: false,
};

const retryOptions: OperationOptions = {
  retries: 3,
  factor: 1.5,
  minTimeout: 100,
};

function getTempFilePath(filePath: string): string {
  return `${filePath}.tmp`;
}

/**
 * Execute a function that writes to a stream atomically.
 * The stream is opened to a temporary file and renamed to the target file on success.
 * The process is protected by a file lock.
 */
export async function writeStreamAtomic(
  filePath: string,
  handler: (stream: fs.WriteStream) => Promise<void>,
  options?: { encoding?: BufferEncoding; highWaterMark?: number },
): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  const tempFilePath = getTempFilePath(resolvedPath);

  // Lock the target file to prevent concurrent writes from other processes
  const unlock = await lockfile.lock(resolvedPath, {
    ...lockOptions,
    retries: retryOptions,
  });

  const stream = fs.createWriteStream(tempFilePath, options);
  try {
    await handler(stream);
    await fs.promises.rename(tempFilePath, resolvedPath);
  } catch (e) {
    if (!stream.destroyed) {
      stream.destroy();
    }
    throw e;
  } finally {
    await fs.promises.unlink(tempFilePath).catch(() => {
      // ignore cleanup errors
    });
    await unlock();
  }
}
