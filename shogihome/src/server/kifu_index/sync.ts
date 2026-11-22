import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  getKifuList,
  clearKifuListCache,
  statIndexableKifuFile,
  type KifuFileEvent,
} from "@/server/helpers/kifu";
import { normalizePath } from "@/common/helpers/path";
import {
  getKifuFileByPath,
  getAllKifuFilePaths,
  upsertKifuFile,
  updateKifuFileStrategy,
  deleteKifuFile,
  getKifuCount,
  KIFU_POSITION_INDEX_VERSION,
} from "@/server/database/kifu_index";
import { buildKifuPositions, parseKifuFile } from "./engine.js";
import { STRATEGY_INDEX_VERSION } from "./strategy.js";

const SYNC_SLICE_MS = 8;

export interface SyncStatus {
  total: number;
  indexed: number;
  isIndexing: boolean;
  lastError?: string;
}

const syncStatus: SyncStatus = {
  total: 0,
  indexed: 0,
  isIndexing: false,
};

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

let isStopRequested = false;

export function stopIndexing() {
  isStopRequested = true;
}

/**
 * Perform a full sync of the kifu directory with the database.
 * This function handles additions, updates, and deletions.
 */
export async function syncKifuDirectory(kifuDir: string) {
  if (syncStatus.isIndexing) {
    return;
  }
  // Wait for a running event batch to settle instead of racing with it.
  while (isProcessingEvents && eventBatchCompletion) {
    await eventBatchCompletion;
    if (syncStatus.isIndexing) {
      return;
    }
  }

  syncStatus.isIndexing = true;
  isStopRequested = false;
  try {
    // 1. Get all files in the directory (clear cache to ensure fresh data)
    clearKifuListCache();
    const files = await getKifuList(kifuDir);
    syncStatus.total = files.length;
    syncStatus.indexed = getKifuCount();

    // 2. Identify files to index (new or changed) and files to delete
    const filesOnDisk = new Set<string>();
    const filesToIndex: string[] = [];
    let sliceStart = performance.now();
    for (const relPath of files) {
      if (performance.now() - sliceStart >= SYNC_SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
      const file = statIndexableKifuFile(kifuDir, relPath);
      if (!file) continue;
      filesOnDisk.add(relPath);
      const existing = getKifuFileByPath(relPath);

      if (
        !existing ||
        existing.mtime !== file.stat.mtimeMs ||
        existing.size !== file.stat.size ||
        existing.strategy_index_version !== STRATEGY_INDEX_VERSION ||
        existing.position_index_version !== KIFU_POSITION_INDEX_VERSION
      ) {
        filesToIndex.push(relPath);
      }
    }

    // Identify files to delete (in DB but not on disk)
    const allPathsInDB = getAllKifuFilePaths();
    for (const dbPath of allPathsInDB) {
      if (!filesOnDisk.has(dbPath)) {
        deleteKifuFile(dbPath);
        if (performance.now() - sliceStart >= SYNC_SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      }
    }

    // 3. Background indexing loop
    for (let i = 0; i < filesToIndex.length; i++) {
      if (isStopRequested) break;

      const relPath = filesToIndex[i];
      try {
        const result = await parseKifuFile(kifuDir, relPath);
        if (result) {
          const existing = getKifuFileByPath(relPath);
          if (
            existing &&
            existing.mtime === result.metadata.mtime &&
            existing.size === result.metadata.size &&
            existing.position_index_version === KIFU_POSITION_INDEX_VERSION
          ) {
            updateKifuFileStrategy(result.metadata);
          } else {
            upsertKifuFile(result.metadata, buildKifuPositions(result.first));
          }
        } else {
          deleteKifuFile(relPath);
        }
      } catch (e) {
        console.error(`Failed to index file: ${relPath}`, e);
        syncStatus.lastError = String(e);
      }

      if (i % 10 === 0 || i === filesToIndex.length - 1) {
        syncStatus.indexed = getKifuCount();
      }

      // Yield to the event loop
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error("Critical error during kifu indexing:", e);
    syncStatus.lastError = String(e);
  } finally {
    syncStatus.isIndexing = false;
    isStopRequested = false;
    syncStatus.indexed = getKifuCount();
  }
}

let eventDebounceTimer: NodeJS.Timeout | null = null;
let isProcessingEvents = false;
let eventBatchCompletion: Promise<void> | null = null;
const pendingEvents = new Map<string, KifuFileEvent>();

function isInRemovedDirectory(filePath: string, directories: Set<string>): boolean {
  let current = filePath;
  while (current) {
    if (directories.has(current)) return true;
    const separator = current.lastIndexOf("/");
    current = separator === -1 ? "" : current.slice(0, separator);
  }
  return directories.has("");
}

/**
 * Handle real-time file system events with debounce.
 */
export function onKifuFileEvent(event: KifuFileEvent, kifuDir: string, relPath: string) {
  const normalizedPath = normalizePath(relPath);
  pendingEvents.set(normalizedPath, event);

  if (eventDebounceTimer) {
    clearTimeout(eventDebounceTimer);
  }

  eventDebounceTimer = setTimeout(async function processEvents() {
    if (syncStatus.isIndexing || isProcessingEvents) {
      eventDebounceTimer = setTimeout(processEvents, 500);
      return;
    }
    eventDebounceTimer = null;
    isProcessingEvents = true;
    eventBatchCompletion = (async () => {
      try {
        const events = new Map(pendingEvents);
        pendingEvents.clear();

        const removedDirectories = new Set(
          [...events].filter(([, ev]) => ev === "unlinkDir").map(([path]) => path),
        );
        if (removedDirectories.size) {
          // Expand directory removals once, preserving newer file additions and changes.
          try {
            for (const indexedPath of getAllKifuFilePaths()) {
              if (!isInRemovedDirectory(indexedPath, removedDirectories)) continue;
              const latestEvent = events.get(indexedPath);
              if (latestEvent !== "add" && latestEvent !== "change") {
                events.set(indexedPath, "unlink");
              }
            }
          } catch (e) {
            console.error("Error expanding kifu directory removal events:", e);
          }
        }

        let processed = 0;
        for (const [path, ev] of events) {
          if (ev === "unlinkDir") continue;
          try {
            if (ev === "unlink") {
              deleteKifuFile(path);
            } else {
              const result = await parseKifuFile(kifuDir, path);
              if (result) {
                upsertKifuFile(result.metadata, buildKifuPositions(result.first));
              } else {
                deleteKifuFile(path);
              }
            }
          } catch (e) {
            console.error(`Error handling kifu file event (${ev}) for ${path}:`, e);
          }
          if (++processed % 10 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }

        if (
          [...events.values()].some((ev) => ev === "add" || ev === "unlink" || ev === "unlinkDir")
        ) {
          clearKifuListCache();
          try {
            const files = await getKifuList(kifuDir);
            syncStatus.total = files.length;
          } catch (e) {
            console.error("Error refreshing kifu list after event processing:", e);
          }
        }
        syncStatus.indexed = getKifuCount();
      } finally {
        isProcessingEvents = false;
      }
    })();
    // Errors are logged inside; avoid unhandled rejections of the completion promise.
    eventBatchCompletion.catch(() => undefined);
  }, 500);
}
