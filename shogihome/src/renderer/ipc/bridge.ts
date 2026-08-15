import { BookLoadingMode } from "@/common/book";
import { MenuEvent } from "@/common/control/menu";
import { AppState, ResearchState } from "@/common/control/state";
import { RecordFileFormat, KifuSearchResult, KifuListEntry } from "@/common/file/record";
import { GameResult } from "@/common/game/result";
import { LogLevel, LogType } from "@/common/log";
import type {
  KifuSearchQuery,
  SfenExportJobStatus,
  SfenExportRequest,
} from "@/common/file/sfen_export";

export interface Bridge {
  // Core
  updateAppState(appState: AppState, researchState: ResearchState, busy: boolean): void;
  onClosable(): void;
  onClose(callback: (confirmations: string[]) => void): void;
  onSendError(callback: (e: string) => void): void;
  onSendMessage(callback: (json: string) => void): void;
  onMenuEvent(callback: (event: MenuEvent) => void): void;

  // Settings
  loadAppSettings(): Promise<string>;
  saveAppSettings(settings: string): Promise<void>;
  loadBatchConversionSettings(): Promise<string>;
  saveBatchConversionSettings(settings: string): Promise<void>;
  loadResearchSettings(): Promise<string>;
  saveResearchSettings(settings: string): Promise<void>;
  loadAnalysisSettings(): Promise<string>;
  saveAnalysisSettings(settings: string): Promise<void>;
  loadGameSettings(): Promise<string>;
  saveGameSettings(settings: string): Promise<void>;
  loadMateSearchSettings(): Promise<string>;
  saveMateSearchSettings(settings: string): Promise<void>;
  loadUSIEngines(): Promise<string>;
  saveUSIEngines(egneins: string): Promise<void>;
  loadBookImportSettings(): Promise<string>;
  saveBookImportSettings(json: string): Promise<void>;
  onUpdateAppSettings(callback: (json: string) => void): void;

  // Record File
  fetchInitialRecordFileRequest(): Promise<string>;
  showOpenRecordDialog(formats: RecordFileFormat[]): Promise<string>;
  showSaveRecordDialog(defaultPath: string): Promise<string>;
  showSaveMergedRecordDialog(defaultPath: string): Promise<string>;
  openRecord(path: string): Promise<Uint8Array>;
  saveRecord(path: string, data: Uint8Array): Promise<void>;
  loadRecordFileHistory(): Promise<string>;
  addRecordFileHistory(path: string): void;
  clearRecordFileHistory(): Promise<void>;
  saveRecordFileBackup(kif: string): Promise<void>;
  loadRecordFileBackup(name: string): Promise<string>;
  loadRemoteTextFile(url: string): Promise<string>;
  convertRecordFiles(json: string): Promise<string>;
  loadSFENFile(path: string): Promise<string[]>;
  onOpenRecord(callback: (path: string) => void): void;

  // Book
  showOpenBookDialog(): Promise<string>;
  showSaveBookDialog(defaultPath: string): Promise<string>;
  openBook(path: string, json: string, sessionId?: string): Promise<BookLoadingMode>;
  saveBook(path: string, sessionId?: string): Promise<void>;
  closeBookSession(sessionId: string): Promise<void>;
  clearBook(sessionId?: string, format?: string): Promise<void>;
  searchBookMoves(sfen: string, sessionId?: string): Promise<string>;
  searchBookMovesBatch(sfens: string[], sessionId?: string): Promise<string>;
  updateBookMove(sfen: string, move: string, sessionId?: string): Promise<void>;
  removeBookMove(sfen: string, usi: string, sessionId?: string): Promise<void>;
  updateBookMoveOrder(sfen: string, usi: string, order: number, sessionId?: string): Promise<void>;
  importBookMoves(json: string, sessionId?: string): Promise<string>;

  // USI
  showSelectUSIEngineDialog(): Promise<string>;
  getUSIEngineInfo(path: string, timeoutSeconds: number): Promise<string>;
  sendUSIOptionButtonSignal(path: string, name: string, timeoutSeconds: number): Promise<void>;
  usiLaunch(json: string, timeoutSeconds: number): Promise<number>;
  usiReady(sessionID: number): Promise<void>;
  usiSetOption(sessionID: number, name: string, value: string): Promise<void>;
  usiGo(sessionID: number, usi: string, timeStatesJSON: string): Promise<void>;
  usiGoPonder(sessionID: number, usi: string, timeStatesJSON: string): Promise<void>;
  usiPonderHit(sessionID: number, timeStatesJSON: string): Promise<void>;
  usiGoInfinite(sessionID: number, usi: string): Promise<void>;
  usiGoMate(sessionID: number, usi: string, maxSeconds?: number): Promise<void>;
  usiStop(sessionID: number): Promise<void>;
  usiGameover(sessionID: number, result: GameResult): Promise<void>;
  usiQuit(sessionID: number): Promise<void>;
  onUSIBestMove(
    callback: (sessionID: number, usi: string, usiMove: string, ponder?: string) => void,
  ): void;
  onUSICheckmate(callback: (sessionID: number, usi: string, usiMoves: string[]) => void): void;
  onUSICheckmateNotImplemented(callback: (sessionID: number) => void): void;
  onUSICheckmateTimeout(callback: (sessionID: number, usi: string) => void): void;
  onUSINoMate(callback: (sessionID: number, usi: string) => void): void;
  onUSIInfo(callback: (sessionID: number, usi: string, json: string) => void): void;

  // Images
  showSelectImageDialog(defaultURL?: string): Promise<string>;
  cropPieceImage(srcURL: string, deleteMargin: boolean): Promise<string>;
  exportCaptureAsPNG(json: string): Promise<void>;
  exportCaptureAsJPEG(json: string): Promise<void>;

  // Log
  openLogFile(logType: LogType): void;
  log(level: LogLevel, message: string): void;

  // MISC
  showSelectFileDialog(): Promise<string>;
  showSelectDirectoryDialog(defaultPath?: string): Promise<string>;
  openExplorer(path: string): void;
  openWebBrowser(url: string): void;
  isEncryptionAvailable(): Promise<boolean>;
  getVersionStatus(): Promise<string>;
  sendTestNotification(): void;
  getPathForFile(file: File): string;
  onProgress(callback: (progress: number) => void): void;

  // Server Kifu (LAN only)
  isServerKifuEnabled(): Promise<boolean>;
  listServerKifu(dir?: string, reload?: boolean): Promise<KifuListEntry[]>;
  searchServerKifu(
    params: KifuSearchQuery & { limit?: number; offset?: number },
  ): Promise<KifuSearchResult[]>;
  countServerKifu(params: KifuSearchQuery): Promise<number>;
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
  saveServerKifu(path: string, data: Uint8Array): Promise<void>;
}
