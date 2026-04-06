import fs from "node:fs";
import path from "node:path";
import { getKifuList, clearKifuListCache } from "@/background/helpers/kifu.js";
import { normalizePath } from "@/common/helpers/path.js";
import {
  getKifuFileByPath,
  getAllKifuFilePaths,
  upsertKifuFile,
  deleteKifuFile,
  getKifuCount,
  cleanupOrphanedPositions,
} from "@/background/database/kifu_index.js";
import { parseAndIndexFile } from "./engine.js";

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

  syncStatus.isIndexing = true;
  isStopRequested = false;
  try {
    // 1. Get all files in the directory (clear cache to ensure fresh data)
    clearKifuListCache();
    const files = await getKifuList(kifuDir);
    syncStatus.total = files.length;
    syncStatus.indexed = getKifuCount();

    // 2. Identify files to index (new or changed) and files to delete
    const filesOnDisk = new Set(files);
    const filesToIndex: string[] = [];
    for (const relPath of files) {
      const fullPath = path.join(kifuDir, relPath);
      const stats = fs.lstatSync(fullPath);
      const existing = getKifuFileByPath(relPath);

      if (!existing || existing.mtime !== stats.mtimeMs || existing.size !== stats.size) {
        filesToIndex.push(relPath);
      }
    }

    // Identify files to delete (in DB but not on disk)
    const allPathsInDB = getAllKifuFilePaths();
    for (const dbPath of allPathsInDB) {
      if (!filesOnDisk.has(dbPath)) {
        deleteKifuFile(dbPath);
      }
    }

    // 3. Background indexing loop
    for (let i = 0; i < filesToIndex.length; i++) {
      if (isStopRequested) break;

      const relPath = filesToIndex[i];
      try {
        const result = await parseAndIndexFile(kifuDir, relPath);
        if (result) {
          upsertKifuFile(result.metadata, result.positions);
        }
      } catch (e) {
        console.error(`Failed to index file: ${relPath}`, e);
        syncStatus.lastError = String(e);
      }

      if (i % 10 === 0 || i === filesToIndex.length - 1) {
        syncStatus.indexed = getKifuCount();
      }

      // Yield to the event loop
      await new Promise((resolve) => setImmediate(resolve));
    }

    // 4. Final cleanup of orphaned positions
    cleanupOrphanedPositions();
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
const pendingEvents = new Map<string, "add" | "change" | "unlink">();

/**
 * Handle real-time file system events with debounce.
 */
export function onKifuFileEvent(
  event: "add" | "change" | "unlink",
  kifuDir: string,
  relPath: string,
) {
  const normalizedPath = normalizePath(relPath);
  pendingEvents.set(normalizedPath, event);

  if (eventDebounceTimer) {
    clearTimeout(eventDebounceTimer);
  }

  eventDebounceTimer = setTimeout(async function processEvents() {
    if (syncStatus.isIndexing) {
      eventDebounceTimer = setTimeout(processEvents, 500);
      return;
    }
    eventDebounceTimer = null;
    const events = Array.from(pendingEvents.entries());
    pendingEvents.clear();

    for (const [path, ev] of events) {
      try {
        if (ev === "unlink") {
          deleteKifuFile(path);
        } else {
          const result = await parseAndIndexFile(kifuDir, path);
          if (result) {
            upsertKifuFile(result.metadata, result.positions);
          }
        }
      } catch (e) {
        console.error(`Error handling kifu file event (${ev}) for ${path}:`, e);
      }
    }

    cleanupOrphanedPositions();

    if (events.some(([, ev]) => ev === "add" || ev === "unlink")) {
      clearKifuListCache();
      const files = await getKifuList(kifuDir);
      syncStatus.total = files.length;
    }
    syncStatus.indexed = getKifuCount();
  }, 500);
}
