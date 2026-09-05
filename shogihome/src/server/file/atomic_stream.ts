import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  return path.join(path.dirname(filePath), `.atomic-${randomUUID()}.tmp`);
}

export type WriteStreamAtomicOptions = {
  encoding?: BufferEncoding;
  highWaterMark?: number;
  overwrite?: boolean;
  /**
   * Called after the handler completed and the temporary file is fully written,
   * but before the target file is replaced. The target file is still the old
   * content at this point and the temporary file is complete.
   * If this hook throws, the target file is not modified and the temporary file
   * is cleaned up. The hook is responsible for releasing any resources (e.g.
   * file handles) it opened when it fails.
   */
  beforePublish?: (tempFilePath: string) => Promise<void>;
  /**
   * Called synchronously right after the target file has been replaced.
   * Errors thrown here are logged and do not fail the operation because the
   * file has already been published.
   */
  onPublished?: () => void;
};

/**
 * Execute a function that writes to a stream atomically.
 * The stream is opened to a temporary file and renamed to the target file on success.
 * The process is protected by a file lock.
 */
export async function writeStreamAtomic(
  filePath: string,
  handler: (stream: fs.WriteStream) => Promise<void>,
  options?: WriteStreamAtomicOptions,
): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  const tempFilePath = getTempFilePath(resolvedPath);
  const { overwrite, beforePublish, onPublished, ...streamOptions } = options ?? {};

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
  let failure: unknown;
  let failed = false;
  let published = false;
  try {
    stream = fs.createWriteStream(tempFilePath, { ...streamOptions, flags: "wx" });
    stream.on("error", onStreamError);
    handlerPromise = handler(stream);
    await Promise.race([handlerPromise, streamErrorPromise]);
    if (streamError) {
      throw streamError;
    }
    // Ensure the temporary file is fully flushed before publishing.
    if (stream && !stream.destroyed) {
      if (!stream.writableEnded) {
        stream.end();
      }
      await finished(stream);
    }
    await beforePublish?.(tempFilePath);
    if (overwrite === false) {
      await fs.promises.link(tempFilePath, resolvedPath);
      await fs.promises.unlink(tempFilePath);
    } else {
      await fs.promises.rename(tempFilePath, resolvedPath);
    }
    published = true;
  } catch (e) {
    failed = true;
    failure = e;
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
    await handlerPromise?.catch(() => undefined);
    if (stream) {
      await finished(stream, { cleanup: true }).catch(() => undefined);
    }
  } finally {
    stream?.off("error", onStreamError);
    await fs.promises.unlink(tempFilePath).catch(() => {
      // ignore cleanup errors
    });
  }

  // The file has been published (or the operation already failed). From here on
  // errors must not turn a successful publish into a reported failure.
  if (published) {
    try {
      onPublished?.();
    } catch (e) {
      console.error("writeStreamAtomic: post-publish callback failed", e);
    }
  }
  try {
    await unlock();
  } catch (e) {
    console.error(
      published
        ? "writeStreamAtomic: failed to release the file lock after publishing"
        : "writeStreamAtomic: failed to release the file lock",
      e,
    );
  }
  if (failed) {
    throw failure;
  }
}
