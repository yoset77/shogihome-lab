import { normalizePath } from "@/common/helpers/path";
import type { ServerDirectoryList, ServerFileUploadResult } from "@/common/file/upload";
import { ApiResponseError } from "@/renderer/api/client";
import api from "@/renderer/ipc/api";
import { useBusyState } from "@/renderer/store/busy";

export interface ServerFileUploadBatchResult {
  uploaded: ServerFileUploadResult[];
  conflicts: File[];
  errors: Error[];
}

const destinationPath = (directory: string, fileName: string) =>
  normalizePath(directory ? `${directory}/${fileName}` : fileName);

export const listUploadDirectories = (directory = ""): Promise<ServerDirectoryList> =>
  api.listServerDirectories(directory);

export async function uploadServerFiles(
  files: File[],
  directory: string,
  overwrite = false,
): Promise<ServerFileUploadBatchResult> {
  const result: ServerFileUploadBatchResult = { uploaded: [], conflicts: [], errors: [] };
  const busy = useBusyState();
  busy.retain();
  try {
    for (const file of files) {
      try {
        result.uploaded.push(
          await api.uploadServerFile(destinationPath(directory, file.name), file, overwrite),
        );
      } catch (error) {
        if (!overwrite && error instanceof ApiResponseError && error.status === 409) {
          result.conflicts.push(file);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(new Error(`${file.name}: ${message}`));
        }
      }
    }
  } finally {
    busy.release();
  }
  return result;
}
