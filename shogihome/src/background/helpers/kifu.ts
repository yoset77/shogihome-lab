import fs from "fs";
import path from "path";
import { watch, FSWatcher } from "chokidar";
import { normalizePath } from "@/common/helpers/path";

export const SUPPORTED_EXTENSIONS = [".kif", ".kifu", ".ki2", ".ki2u", ".csa", ".jkf"];
const BOOK_EXTENSIONS = [".db", ".bin"];
const POSITION_EXTENSIONS = [".sfen"];
const MAX_DEPTH = 10;
const MAX_FILES = 100000;

let cachedKifuList: string[] | null = null;

const isWithinBaseDirectory = (baseDir: string, targetPath: string): boolean => {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const findNearestExistingPath = (targetPath: string): string | null => {
  let currentPath = targetPath;
  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
  return currentPath;
};

/**
 * Clears the in-memory kifu list cache.
 */
export const clearKifuListCache = (): void => {
  cachedKifuList = null;
};

/**
 * Recursively lists files under the base directory.
 * @param baseDir Absolute path to the base directory.
 * @param extensions Allowed extensions.
 * @returns Relative paths of files.
 */
const getFileList = async (baseDir: string, extensions: string[]): Promise<string[]> => {
  const result: string[] = [];

  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || result.length >= MAX_FILES) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      console.error(`failed to read directory: ${dir}`, e);
      return;
    }

    for (const entry of entries) {
      if (result.length >= MAX_FILES) {
        break;
      }

      if (entry.isSymbolicLink()) {
        continue;
      }

      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(res, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          result.push(normalizePath(path.relative(baseDir, res)));
        }
      }
    }
  };

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  await walk(baseDir, 0);
  return result;
};

/**
 * Recursively lists kifu files under the base directory.
 * @param baseDir Absolute path to the base directory.
 * @returns Relative paths of kifu files.
 */
export const getKifuList = async (baseDir: string): Promise<string[]> => {
  if (cachedKifuList !== null) {
    return cachedKifuList;
  }
  cachedKifuList = await getFileList(baseDir, SUPPORTED_EXTENSIONS);
  return cachedKifuList;
};

/**
 * Recursively lists book files under the base directory.
 * @param baseDir Absolute path to the base directory.
 * @returns Relative paths of book files.
 */
export const getBookList = async (baseDir: string): Promise<string[]> => {
  return await getFileList(baseDir, BOOK_EXTENSIONS);
};

/**
 * Recursively lists position files under the base directory.
 * @param baseDir Absolute path to the base directory.
 * @returns Relative paths of position files.
 */
export const getPositionList = async (baseDir: string): Promise<string[]> => {
  return await getFileList(baseDir, POSITION_EXTENSIONS);
};

/**
 * Sets up a file system watcher to invalidate the cache when files change.
 * @param baseDir Absolute path to the base directory.
 * @param usePolling Whether to use polling instead of native events.
 * @returns The watcher instance or null if failed to start.
 */
export const setupKifuWatcher = (
  baseDir: string,
  usePolling = false,
  onEvent?: (event: "add" | "change" | "unlink", relPath: string) => void,
): FSWatcher | null => {
  if (!fs.existsSync(baseDir)) {
    return null;
  }
  try {
    const watcher = watch(baseDir, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      usePolling,
      interval: 1000,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    watcher.on("all", (event, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const isKifu = SUPPORTED_EXTENSIONS.includes(ext);
      if (
        isKifu ||
        BOOK_EXTENSIONS.includes(ext) ||
        POSITION_EXTENSIONS.includes(ext) ||
        event === "addDir" ||
        event === "unlinkDir"
      ) {
        clearKifuListCache();
      }
      if (onEvent && isKifu && (event === "add" || event === "change" || event === "unlink")) {
        onEvent(event, normalizePath(path.relative(baseDir, filePath)));
      }
    });

    console.log(
      `Started watching kifu directory with chokidar (polling: ${usePolling}): ${baseDir}`,
    );
    return watcher;
  } catch (e) {
    console.warn("Failed to start kifu directory watcher:", e);
    return null;
  }
};

/**
 * Resolves a relative path to an absolute path and verifies it's within the base directory.
 * @param baseDir Absolute path to the base directory.
 * @param relPath Relative path to resolve.
 * @returns Absolute path or null if invalid or outside base directory.
 */
export const resolveKifuPath = (baseDir: string, relPath: string): string | null => {
  if (!relPath || typeof relPath !== "string") {
    return null;
  }

  // Security: Do not allow any path traversal segments.
  const segments = normalizePath(relPath).split("/");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  // Security: Limit directory depth.
  if (segments.filter(Boolean).length > 11) {
    return null;
  }

  // Security: Basic check for extension.
  const ext = path.extname(relPath).toLowerCase();
  const isSupportedExt =
    SUPPORTED_EXTENSIONS.includes(ext) ||
    BOOK_EXTENSIONS.includes(ext) ||
    POSITION_EXTENSIONS.includes(ext);

  // Normalize and resolve the path.
  const fullPath = path.resolve(baseDir, relPath);

  // Security: Use path.sep suffix to prevent prefix-collision attack.
  // e.g. baseDir="/data/kifu" must not match "/data/kifu-evil/..."
  const normalizedBaseDir = path.resolve(baseDir);
  const baseDirWithSep = normalizedBaseDir.endsWith(path.sep)
    ? normalizedBaseDir
    : normalizedBaseDir + path.sep;

  if (!fullPath.startsWith(baseDirWithSep)) {
    return null;
  }

  // Security: Check if it's a supported extension OR it's an existing directory.
  // We allow non-existent paths only if they have a supported extension (for file creation).
  // For paths without a supported extension, we only allow them if they are existing directories.
  if (!isSupportedExt && !(fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory())) {
    return null;
  }

  try {
    const realBaseDir = fs.realpathSync(normalizedBaseDir);
    const existingPath = findNearestExistingPath(fullPath);
    if (!existingPath) {
      return null;
    }
    const realExistingPath = fs.realpathSync(existingPath);
    if (!isWithinBaseDirectory(realBaseDir, realExistingPath)) {
      return null;
    }
  } catch {
    return null;
  }

  return fullPath;
};
