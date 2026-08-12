import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
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
  options?: { encoding?: BufferEncoding; highWaterMark?: number; overwrite?: boolean },
): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  const tempFilePath = getTempFilePath(resolvedPath);
  const { overwrite, ...streamOptions } = options ?? {};

  // Lock the target file to prevent concurrent writes from other processes
  const unlock = await lockfile.lock(resolvedPath, {
    ...lockOptions,
    retries: retryOptions,
  });

  let stream: fs.WriteStream | undefined;
  let streamError: Error | undefined;
  let rejectStreamError: ((error: Error) => void) | undefined;
  const streamErrorPromise = new Promise<never>((_, reject) => {
    rejectStreamError = reject;
  });
  const onStreamError = (error: Error) => {
    streamError ??= error;
    rejectStreamError?.(error);
  };

  let handlerPromise: Promise<void> | undefined;
  try {
    stream = fs.createWriteStream(tempFilePath, streamOptions);
    stream.on("error", onStreamError);
    handlerPromise = handler(stream);
    await Promise.race([handlerPromise, streamErrorPromise]);
    if (streamError) {
      throw streamError;
    }
    if (overwrite === false) {
      await fs.promises.link(tempFilePath, resolvedPath);
      await fs.promises.unlink(tempFilePath);
    } else {
      await fs.promises.rename(tempFilePath, resolvedPath);
    }
  } catch (e) {
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
    await handlerPromise?.catch(() => undefined);
    if (stream) {
      await finished(stream, { cleanup: true }).catch(() => undefined);
    }
    throw e;
  } finally {
    stream?.off("error", onStreamError);
    await fs.promises.unlink(tempFilePath).catch(() => {
      // ignore cleanup errors
    });
    await unlock();
  }
}
