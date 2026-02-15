import fs from "node:fs";
import path from "node:path";
import lockfile, { LockOptions } from "proper-lockfile";
import { OperationOptions } from "retry";

// EXTENSIONS:
//   .tmp  - temporary file
//   .lock - lock file

function getTempFilePath(filePath: string): string {
  return `${filePath}.tmp`;
}

const lockOptions: LockOptions = {
  stale: 5000, // 5 seconds is a minimum allowed value
  realpath: false, // should be false because the file may not exist yet
};

// retry options are available only in the async version
const retryOptions: OperationOptions = {
  retries: 3,
  factor: 1.5,
  minTimeout: 100,
};

/**
 * Create or update a file atomically.
 * At first, the data is written to a temporary file.
 * Then, the temporary file is renamed to the target file.
 * And the whole process is protected by a file lock.
 *
 * @param filePath target file path
 * @param data data to write
 * @param encoding character encoding
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = getTempFilePath(filePath);
  const unlock = await lockfile.lock(filePath, {
    ...lockOptions,
    retries: retryOptions,
  });
  try {
    await fs.promises.writeFile(tempFilePath, data, encoding);
    await fs.promises.rename(tempFilePath, filePath);
  } finally {
    await fs.promises.unlink(tempFilePath).catch(() => {
      // ignore cleanup errors
    });
    await unlock();
  }
}

/**
 * Synchronous version of writeFileAtomic.
 */
export function writeFileAtomicSync(
  filePath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFilePath = getTempFilePath(filePath);
  const unlock = lockfile.lockSync(filePath, lockOptions);
  try {
    fs.writeFileSync(tempFilePath, data, encoding);
    fs.renameSync(tempFilePath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // ignore cleanup errors
    }
    unlock();
  }
}
