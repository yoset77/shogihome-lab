export type ServerFileKind = "kifu" | "book" | "sfen";

export const SERVER_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// Atomic writers own this namespace. Include Windows case and trailing-dot/space aliases.
export const isReservedServerEntryName = (name: string): boolean => /\.lock[. ]*$/i.test(name);

export const isValidServerEntryName = (name: string): boolean => {
  if (
    !name ||
    name !== name.trim() ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    isReservedServerEntryName(name) ||
    /[\\/:*?"<>|\p{Cc}]/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    return false;
  }
  // Reserve five bytes for the atomic writer's .lock suffix.
  return new TextEncoder().encode(name).byteLength <= 250;
};

export const KIFU_UPLOAD_EXTENSIONS = [".kif", ".kifu", ".ki2", ".ki2u", ".csa", ".jkf"];
export const BOOK_UPLOAD_EXTENSIONS = [".db", ".bin", ".sbk", ".ybb"];
export const POSITION_UPLOAD_EXTENSIONS = [".sfen"];
export const SERVER_UPLOAD_ACCEPT = [
  ...KIFU_UPLOAD_EXTENSIONS,
  ...BOOK_UPLOAD_EXTENSIONS,
  ...POSITION_UPLOAD_EXTENSIONS,
].join(",");

export const getServerFileKind = (filePath: string): ServerFileKind | null => {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  if (KIFU_UPLOAD_EXTENSIONS.includes(ext)) return "kifu";
  if (BOOK_UPLOAD_EXTENSIONS.includes(ext)) return "book";
  if (POSITION_UPLOAD_EXTENSIONS.includes(ext)) return "sfen";
  return null;
};

export interface ServerDirectoryEntry {
  name: string;
  path: string;
}

export interface ServerDirectoryList {
  path: string;
  directories: ServerDirectoryEntry[];
}

export interface ServerFileUploadResult {
  path: string;
  kind: ServerFileKind;
  size: number;
  overwritten: boolean;
}
