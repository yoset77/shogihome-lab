import { BookLoadingMode } from "@/common/book";
import { RecordFileFormat, KifuSearchResult, KifuListEntry } from "@/common/file/record";
import type { KifuSearchStatistics } from "@/common/file/kifu_statistics";
import { LogLevel } from "@/common/log";
import type {
  KifuSearchQuery,
  SfenExportJobStatus,
  SfenExportRequest,
} from "@/common/file/sfen_export";
import type {
  ServerDirectoryEntry,
  ServerDirectoryList,
  ServerFileUploadResult,
} from "@/common/file/upload";

export interface Bridge {
  // Settings
  loadAppSettings(): Promise<string>;
  saveAppSettings(settings: string): Promise<void>;
  loadResearchSettings(): Promise<string>;
  saveResearchSettings(settings: string): Promise<void>;
  loadAnalysisSettings(): Promise<string>;
  saveAnalysisSettings(settings: string): Promise<void>;
  loadGameSettings(): Promise<string>;
  saveGameSettings(settings: string): Promise<void>;
  loadMateSearchSettings(): Promise<string>;
  saveMateSearchSettings(settings: string): Promise<void>;
  loadBookImportSettings(): Promise<string>;
  saveBookImportSettings(json: string): Promise<void>;

  // Record File
  showOpenRecordDialog(formats: RecordFileFormat[]): Promise<string>;
  showSaveRecordDialog(defaultPath: string): Promise<string>;
  openRecord(path: string): Promise<Uint8Array>;
  saveRecord(path: string, data: Uint8Array): Promise<void>;
  loadRecordFileHistory(): Promise<string>;
  addRecordFileHistory(path: string): void;
  clearRecordFileHistory(): Promise<void>;
  saveRecordFileBackup(kif: string): Promise<void>;
  loadRecordFileBackup(name: string): Promise<string>;
  loadRemoteTextFile(url: string): Promise<string>;
  loadSFENFile(path: string): Promise<string[]>;

  // Book
  showOpenBookDialog(): Promise<string>;
  showSaveBookDialog(defaultPath: string): Promise<string>;
  openBook(path: string, json: string, sessionId?: string): Promise<BookLoadingMode>;
  saveBook(path: string, sessionId?: string, overwriteCurrent?: boolean): Promise<boolean>;
  closeBookSession(sessionId: string): Promise<void>;
  clearBook(sessionId?: string, format?: string): Promise<void>;
  searchBookMoves(sfen: string, sessionId?: string): Promise<string>;
  searchBookMovesBatch(sfens: string[], sessionId?: string): Promise<string>;
  updateBookMove(sfen: string, move: string, sessionId?: string): Promise<void>;
  removeBookMove(sfen: string, usi: string, sessionId?: string): Promise<void>;
  updateBookMoveOrder(sfen: string, usi: string, order: number, sessionId?: string): Promise<void>;
  importBookMoves(json: string, sessionId?: string): Promise<string>;

  // Images
  exportCaptureAsPNG(json: string): Promise<void>;
  exportCaptureAsJPEG(json: string): Promise<void>;

  // Log
  log(level: LogLevel, message: string): void;

  // MISC
  openWebBrowser(url: string): void;
  getPathForFile(file: File): string;

  // Server Kifu (LAN only)
  isServerKifuEnabled(): Promise<boolean>;
  listServerKifu(dir?: string, reload?: boolean): Promise<KifuListEntry[]>;
  listServerDirectories(dir?: string): Promise<ServerDirectoryList>;
  createServerDirectory(parent: string, name: string): Promise<ServerDirectoryEntry>;
  uploadServerFile(path: string, file: File, overwrite?: boolean): Promise<ServerFileUploadResult>;
  searchServerKifu(
    params: KifuSearchQuery & { limit?: number; offset?: number },
  ): Promise<KifuSearchResult[]>;
  countServerKifu(params: KifuSearchQuery): Promise<number>;
  getServerKifuStatistics(params: KifuSearchQuery): Promise<KifuSearchStatistics>;
  startServerKifuSfenExport(params: SfenExportRequest): Promise<SfenExportJobStatus>;
  getServerKifuSfenExport(jobId: string): Promise<SfenExportJobStatus>;
  cancelServerKifuSfenExport(jobId: string): Promise<void>;
  getServerKifuIndexStatus(): Promise<{
    total: number;
    indexed: number;
    isIndexing: boolean;
  }>;
  listServerBook(): Promise<string[]>;
  listServerPosition(): Promise<string[]>;
  loadServerKifu(path: string): Promise<string>;
  saveServerKifu(path: string, data: Uint8Array, overwriteCurrent?: boolean): Promise<boolean>;
}
