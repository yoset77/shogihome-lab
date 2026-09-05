import { normalizePath } from "@/common/helpers/path";
import {
  getServerFileKind,
  isValidServerEntryName,
  type ServerDirectoryEntry,
  type ServerDirectoryList,
  type ServerFileUploadResult,
} from "@/common/file/upload";
import { t } from "@/common/i18n";
import { ApiResponseError } from "@/renderer/api/client";
import api from "@/renderer/ipc/api";
import { useBusyState } from "@/renderer/store/busy";

export interface ServerFileUploadItem {
  readonly file: File;
  baseName: string;
  readonly extension: string;
}

export const createUploadItem = (file: File): ServerFileUploadItem => {
  const dot = file.name.lastIndexOf(".");
  return {
    file,
    baseName: dot > 0 ? file.name.slice(0, dot) : file.name,
    extension: dot > 0 ? file.name.slice(dot) : "",
  };
};

export const getUploadFileName = (item: ServerFileUploadItem): string =>
  item.baseName + item.extension;

export interface ServerFileUploadBatchResult {
  uploaded: ServerFileUploadResult[];
  conflicts: ServerFileUploadItem[];
  errors: Error[];
}

const destinationPath = (directory: string, fileName: string) =>
  normalizePath(directory ? `${directory}/${fileName}` : fileName);

export const listUploadDirectories = (directory = ""): Promise<ServerDirectoryList> =>
  api.listServerDirectories(directory);

export const createUploadDirectory = (
  parent: string,
  name: string,
): Promise<ServerDirectoryEntry> => {
  if (!isValidServerEntryName(name)) throw new Error(t.invalidServerEntryName(name));
  return api.createServerDirectory(parent, name);
};

export async function uploadServerFiles(
  files: ServerFileUploadItem[],
  directory: string,
  overwrite = false,
): Promise<ServerFileUploadBatchResult> {
  const items = files.map((item) => ({ ...item }));
  const names = items.map(getUploadFileName);
  const unsupported = items
    .filter((item) => !item.extension || !getServerFileKind(getUploadFileName(item)))
    .map((item) => item.file.name);
  if (unsupported.length) throw new Error(t.unsupportedUploadFiles(unsupported.join("\n")));
  const invalid = names.filter((name) => !isValidServerEntryName(name));
  if (invalid.length) throw new Error(t.invalidServerEntryName(invalid.join("\n")));
  const seen = new Set<string>();
  const duplicates = names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (duplicates.length) throw new Error(t.duplicateUploadFileNames(duplicates.join("\n")));

  const result: ServerFileUploadBatchResult = { uploaded: [], conflicts: [], errors: [] };
  const busy = useBusyState();
  busy.retain();
  try {
    let pending = items;
    if (!overwrite) {
      // Books can be hundreds of megabytes. Check for existing book files
      // before uploading so the overwrite confirmation appears without
      // sending the bytes first. Kifu and SFEN files stay on the server-side
      // 409 detection because they are small.
      const hasBook = items.some((item) => getServerFileKind(getUploadFileName(item)) === "book");
      if (hasBook) {
        let existing: Set<string> | null = null;
        try {
          existing = new Set(await api.listServerBook());
        } catch {
          existing = null;
        }
        if (existing) {
          pending = [];
          for (const item of items) {
            const name = getUploadFileName(item);
            if (
              getServerFileKind(name) === "book" &&
              existing.has(destinationPath(directory, name))
            ) {
              result.conflicts.push(item);
            } else {
              pending.push(item);
            }
          }
        }
      }
    }
    for (const item of pending) {
      const name = getUploadFileName(item);
      try {
        result.uploaded.push(
          await api.uploadServerFile(destinationPath(directory, name), item.file, overwrite),
        );
      } catch (error) {
        if (!overwrite && error instanceof ApiResponseError && error.status === 409) {
          result.conflicts.push(item);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(new Error(`${name}: ${message}`));
        }
      }
    }
  } finally {
    busy.release();
  }
  return result;
}
