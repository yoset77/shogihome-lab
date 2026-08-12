import { defaultAnalysisSettings } from "@/common/settings/analysis";
import { defaultAppSettings } from "@/common/settings/app";
import { defaultGameSettings } from "@/common/settings/game";
import { defaultResearchSettings } from "@/common/settings/research";
import { USIEngines } from "@/common/settings/usi";
import { LogLevel } from "@/common/log";
import { Bridge } from "@/renderer/ipc/bridge";
import { t } from "@/common/i18n/index";
import { defaultMateSearchSettings } from "@/common/settings/mate";
import { defaultBatchConversionSettings } from "@/common/settings/conversion";
import type {
  KifuSearchQuery,
  SfenExportJobStatus,
  SfenExportRequest,
} from "@/common/file/sfen_export";
import { defaultBookImportSettings, normalizeBookImportSettings } from "@/common/settings/book";
import { getEmptyHistory } from "@/common/file/history";
import { BookLoadingMode } from "@/common/book";
import { VersionStatus } from "@/common/version";
import * as uri from "@/common/uri";
import { normalizePath } from "@/common/helpers/path";
import { KifuSearchResult, KifuListEntry } from "@/common/file/record";
import { decodeText } from "@/common/helpers/encode";
import { toJpeg, toPng } from "html-to-image";
import dayjs from "dayjs";
import { Rect } from "@/common/assets/geometry";
import {
  assertOkResponse,
  createApiRequestOptions,
  createHonoApiClient,
  parseJsonResponse,
} from "@/renderer/api/client";

const toKifuSearchQuery = (params: KifuSearchQuery) => ({
  sfen: params.sfen,
  keyword: params.keyword,
  player1: params.player1,
  player2: params.player2,
  isStrictTurn: params.isStrictTurn ? "true" : "",
  startDate: params.startDate,
});

enum STORAGE_KEY {
  APP_SETTINGS = "appSetting",
  RESEARCH_SETTINGS = "researchSetting",
  BATCH_CONVERSION_SETTINGS = "batchConversionSetting",
  ANALYSIS_SETTINGS = "analysisSetting",
  GAME_SETTINGS = "gameSetting",
  MATE_SEARCH_SETTINGS = "mateSearchSetting",
  BOOK_IMPORT_SETTINGS = "bookImportSetting",
}

const fileCache = new Map<string, ArrayBuffer>();

import { generateSessionId } from "@/renderer/helpers/unique";

const webBookSessionId = generateSessionId();
const apiClient = createHonoApiClient({ getBookSessionId: () => webBookSessionId });

const apiOptions = (options: {
  timeoutMs?: number;
  sessionId?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}) =>
  createApiRequestOptions({
    timeoutMs: options.timeoutMs,
    bookSessionId: options.sessionId,
    headers: options.headers,
    init: options.body === undefined ? undefined : { body: options.body },
  });

async function exportCapture(
  type: "png" | "jpeg",
  execute: (el: HTMLElement, canvasWidth: number, canvasHeight: number) => Promise<string>,
  rectJson: string,
): Promise<void> {
  const element = document.querySelector(".export-board") as HTMLElement;
  if (!element) {
    throw new Error("Element not found: .export-board");
  }
  const rect = new Rect(rectJson);
  const canvasHeight = rect.targetHeight ?? rect.height;
  const canvasWidth = rect.targetWidth ?? rect.width;
  const dataUrl = await execute(element, canvasWidth, canvasHeight);
  const link = document.createElement("a");
  link.download = `shogi_position_${dayjs().format("YYYYMMDD_HHmmss")}.${type}`;
  link.href = dataUrl;
  link.click();
}

// Web/LAN アプリケーションとして実行した場合に使用します。
export const webAPI: Bridge = {
  // Core
  updateAppState(): void {
    // DO NOTHING
  },
  onClosable(): void {
    // Do Nothing
  },
  onClose(): void {
    // Do Nothing
  },
  onSendError(): void {
    // Do Nothing
  },
  onSendMessage(): void {
    // Do Nothing
  },
  onMenuEvent(): void {
    // Do Nothing
  },

  // Settings
  async loadAppSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.APP_SETTINGS);
    if (!json) {
      return JSON.stringify(defaultAppSettings());
    }
    return JSON.stringify({
      ...defaultAppSettings(),
      ...JSON.parse(json),
    });
  },
  async saveAppSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.APP_SETTINGS, json);
  },
  async loadBatchConversionSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.BATCH_CONVERSION_SETTINGS);
    if (!json) {
      return JSON.stringify(defaultBatchConversionSettings());
    }
    return JSON.stringify({
      ...defaultBatchConversionSettings(),
      ...JSON.parse(json),
    });
  },
  async saveBatchConversionSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.BATCH_CONVERSION_SETTINGS, json);
  },
  async loadResearchSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.RESEARCH_SETTINGS);
    if (!json) {
      return JSON.stringify(defaultResearchSettings());
    }
    return JSON.stringify({
      ...defaultResearchSettings(),
      ...JSON.parse(json),
    });
  },
  async saveResearchSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.RESEARCH_SETTINGS, json);
  },
  async loadAnalysisSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.ANALYSIS_SETTINGS);
    if (!json) {
      return JSON.stringify(defaultAnalysisSettings());
    }
    return JSON.stringify({
      ...defaultAnalysisSettings(),
      ...JSON.parse(json),
    });
  },
  async saveAnalysisSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.ANALYSIS_SETTINGS, json);
  },
  async loadGameSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.GAME_SETTINGS);
    if (!json) {
      return JSON.stringify({
        ...defaultGameSettings(),
        enableAutoSave: false,
      });
    }
    return JSON.stringify({
      ...defaultGameSettings(),
      ...JSON.parse(json),
    });
  },
  async saveGameSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.GAME_SETTINGS, json);
  },
  async loadMateSearchSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.MATE_SEARCH_SETTINGS);
    if (!json) {
      return JSON.stringify(defaultMateSearchSettings());
    }
    return JSON.stringify({
      ...defaultMateSearchSettings(),
      ...JSON.parse(json),
    });
  },
  async saveMateSearchSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.MATE_SEARCH_SETTINGS, json);
  },
  async loadUSIEngines(): Promise<string> {
    return new USIEngines().json;
  },
  async saveUSIEngines(): Promise<void> {
    // Do Nothing
  },
  async loadBookImportSettings(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.BOOK_IMPORT_SETTINGS);
    if (!json) {
      return JSON.stringify(defaultBookImportSettings());
    }
    return JSON.stringify(normalizeBookImportSettings(JSON.parse(json)));
  },
  async saveBookImportSettings(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.BOOK_IMPORT_SETTINGS, json);
  },
  onUpdateAppSettings(): void {
    // Do Nothing
  },

  // Record File
  async fetchInitialRecordFileRequest(): Promise<string> {
    return "null";
  },
  async showOpenRecordDialog(formats: string[]): Promise<string> {
    const input = document.createElement("input");
    input.setAttribute("type", "file");
    input.setAttribute("accept", formats.join(","));
    return new Promise<string>((resolve, reject) => {
      input.click();
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) {
          file
            .arrayBuffer()
            .then((data) => {
              const fileURI = uri.issueTempFileURI(file.name);
              fileCache.set(fileURI, data);
              resolve(fileURI);
            })
            .catch((error) => {
              reject(error);
            });
        } else {
          reject(new Error("invalid file"));
        }
      };
      input.oncancel = () => {
        resolve("");
      };
    });
  },
  async showSaveRecordDialog(defualtPath: string): Promise<string> {
    return defualtPath;
  },
  async showSaveMergedRecordDialog(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async openRecord(uri: string): Promise<Uint8Array> {
    const cached = fileCache.get(uri);
    if (cached) {
      return new Uint8Array(cached);
    }
    if (uri.startsWith("server://")) {
      const relPath = uri.substring(9);
      const response = await apiClient.api.kifu.get.$get({ query: { path: relPath } });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      const text = await this.loadRemoteTextFile(uri);
      return new TextEncoder().encode(text);
    }
    return Promise.reject(new Error("invalid URI"));
  },
  async saveRecord(path: string, data: Uint8Array): Promise<void> {
    // パスからファイル名を抽出
    const filename = normalizePath(path).split("/").pop() || "record.kif";

    // 拡張子からMIMEタイプを決定
    let mimeType = "application/octet-stream";
    if (/\.(kif|ki2|csa|sfen)$/i.test(filename)) {
      mimeType = "text/plain";
    } else if (/\.jkf$/i.test(filename)) {
      mimeType = "application/json";
    }

    // <a> タグによるダウンロード
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = new Blob([data as any], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
  async loadRecordFileHistory(): Promise<string> {
    try {
      const response = await apiClient.api.history.$get();
      if (response.ok) {
        const data = await response.json();
        return JSON.stringify(data);
      }
    } catch {
      // Ignore errors silently as backup is an auxiliary feature
    }
    return JSON.stringify(getEmptyHistory());
  },
  addRecordFileHistory(path: string): void {
    if (path.startsWith(uri.ES_TEMP_FILE_PREFIX)) {
      const data = fileCache.get(path);
      if (data) {
        const kif = decodeText(new Uint8Array(data), { autoDetect: true });
        this.saveRecordFileBackup(kif);
      }
      return;
    }
    apiClient.api.history.add
      .$post(
        undefined,
        apiOptions({
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      )
      .catch(() => {
        // Ignore errors silently
      });
  },
  async clearRecordFileHistory(): Promise<void> {
    try {
      await apiClient.api.history.clear.$post();
    } catch {
      // Ignore errors
    }
  },
  async saveRecordFileBackup(kif: string): Promise<void> {
    try {
      await apiClient.api.history.backup.$post(
        undefined,
        apiOptions({ headers: { "Content-Type": "text/plain" }, body: kif }),
      );
    } catch {
      // Ignore errors silently
    }
  },
  async loadRecordFileBackup(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async loadRemoteTextFile(url: string): Promise<string> {
    const response = await apiClient.api["fetch-remote"].$get({ query: { url } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch remote text: ${response.status} ${text}`);
    }
    return await response.text();
  },
  async convertRecordFiles(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async loadSFENFile(path: string): Promise<string[]> {
    if (!path.startsWith("server://")) {
      throw new Error("Only server-side SFEN files are supported");
    }
    const relPath = path.substring(9);
    const response = await apiClient.api.sfen.load.$get({ query: { path: relPath } });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return json.lines;
  },
  onOpenRecord(): void {
    // Do Nothing
  },

  // Book
  async showOpenBookDialog(): Promise<string> {
    const json = await parseJsonResponse<{ enabled: boolean }>(
      await apiClient.api.kifu.enabled.$get(),
    );
    if (!json.enabled) {
      throw new Error(t.thisFeatureNotAvailableOnWebApp);
    }
    // Return a dummy path to trigger the server-side openBook.
    // The actual path will be selected from the kifu list in the UI.
    return "server://";
  },
  async showSaveBookDialog(defaultPath: string): Promise<string> {
    const json = await parseJsonResponse<{ enabled: boolean }>(
      await apiClient.api.kifu.enabled.$get(),
    );
    if (!json.enabled) {
      throw new Error(t.thisFeatureNotAvailableOnWebApp);
    }
    const path = window.prompt(t.cannotOverwriteOnTheFlyBook, defaultPath);
    if (!path) {
      return "";
    }
    return "server://" + path;
  },
  async openBook(path: string, options: string, sessionId?: string): Promise<BookLoadingMode> {
    if (!path.startsWith("server://")) {
      throw new Error("Only server-side books are supported");
    }
    const relPath = path.substring(9);
    const response = await apiClient.api.book.open.$post(
      { query: { path: relPath } },
      apiOptions({
        timeoutMs: 60000,
        sessionId,
        headers: { "Content-Type": "application/json" },
        body: options,
      }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return json.mode;
  },
  async saveBook(path: string, sessionId?: string): Promise<void> {
    if (!path.startsWith("server://")) {
      throw new Error("Only server-side books are supported");
    }
    const relPath = path.substring(9);
    const response = await apiClient.api.book.save.$post(
      { query: { path: relPath } },
      apiOptions({ timeoutMs: 600000, sessionId }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async closeBookSession(sessionId: string): Promise<void> {
    const response = await apiClient.api.book.close.$post(undefined, apiOptions({ sessionId }));
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async clearBook(sessionId?: string): Promise<void> {
    const response = await apiClient.api.book.clear.$post(undefined, apiOptions({ sessionId }));
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async searchBookMoves(sfen: string, sessionId?: string): Promise<string> {
    const response = await apiClient.api.book.search.$get(
      { query: { sfen } },
      apiOptions({ sessionId }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return JSON.stringify(json);
  },
  async searchBookMovesBatch(sfens: string[], sessionId?: string): Promise<string> {
    const response = await apiClient.api.book.search.batch.$post(
      undefined,
      apiOptions({
        timeoutMs: 60000,
        sessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sfens }),
      }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return JSON.stringify(json);
  },
  async updateBookMove(sfen: string, move: string, sessionId?: string): Promise<void> {
    const response = await apiClient.api.book.update.$post(
      { query: { sfen } },
      apiOptions({
        sessionId,
        headers: { "Content-Type": "application/json" },
        body: move,
      }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async removeBookMove(sfen: string, usi: string, sessionId?: string): Promise<void> {
    const response = await apiClient.api.book.remove.$post(
      { query: { sfen, usi } },
      apiOptions({ sessionId }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async updateBookMoveOrder(
    sfen: string,
    usi: string,
    order: number,
    sessionId?: string,
  ): Promise<void> {
    const response = await apiClient.api.book.order.$post(
      { query: { sfen, usi, order: String(order) } },
      apiOptions({ sessionId }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async importBookMoves(json: string, sessionId?: string): Promise<string> {
    const response = await apiClient.api.book.import.$post(
      undefined,
      apiOptions({
        timeoutMs: 600000,
        sessionId,
        headers: { "Content-Type": "application/json" },
        body: json,
      }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const result = await response.json();
    return JSON.stringify(result);
  },

  // USI
  async showSelectUSIEngineDialog(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async getUSIEngineInfo(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async sendUSIOptionButtonSignal(): Promise<void> {
    // Do Nothing
  },
  async usiLaunch(): Promise<number> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async usiReady(): Promise<void> {
    // Do Nothing
  },
  async usiSetOption(): Promise<void> {
    // Do Nothing
  },
  async usiGo(): Promise<void> {
    // Do Nothing
  },
  async usiGoPonder(): Promise<void> {
    // Do Nothing
  },
  async usiPonderHit(): Promise<void> {
    // Do Nothing
  },
  async usiGoInfinite(): Promise<void> {
    // Do Nothing
  },
  async usiGoMate(): Promise<void> {
    // Do Nothing
  },
  async usiStop(): Promise<void> {
    // Do Nothing
  },
  async usiGameover(): Promise<void> {
    // Do Nothing
  },
  async usiQuit(): Promise<void> {
    // Do Nothing
  },
  onUSIBestMove(): void {
    // Do Nothing
  },
  onUSICheckmate(): void {
    // Do Nothing
  },
  onUSICheckmateNotImplemented(): void {
    // Do Nothing
  },
  onUSICheckmateTimeout(): void {
    // Do Nothing
  },
  onUSINoMate(): void {
    // Do Nothing
  },
  onUSIInfo(): void {
    // Do Nothing
  },

  // Images
  async showSelectImageDialog(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async cropPieceImage(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async exportCaptureAsPNG(rectJson: string): Promise<void> {
    return exportCapture(
      "png",
      (el, canvasWidth, canvasHeight) =>
        toPng(el, {
          pixelRatio: 1,
          cacheBust: true,
          backgroundColor: "white",
          canvasWidth,
          canvasHeight,
        }),
      rectJson,
    );
  },
  async exportCaptureAsJPEG(rectJson: string): Promise<void> {
    return exportCapture(
      "jpeg",
      (el, canvasWidth, canvasHeight) =>
        toJpeg(el, {
          pixelRatio: 1,
          cacheBust: true,
          backgroundColor: "white",
          quality: 0.9,
          canvasWidth,
          canvasHeight,
        }),
      rectJson,
    );
  },

  // Log
  openLogFile(): void {
    // Do Nothing
  },
  log(level: LogLevel, message: string): void {
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(message);
        break;
      case LogLevel.INFO:
        console.log(message);
        break;
      case LogLevel.WARN:
        console.warn(message);
        break;
      case LogLevel.ERROR:
        console.error(message);
        break;
    }
  },

  // MISC
  async showSelectFileDialog(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async showSelectDirectoryDialog(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  openExplorer() {
    // DO NOTHING
  },
  openWebBrowser(url: string) {
    window.open(url, "_blank");
  },
  async isEncryptionAvailable(): Promise<boolean> {
    return false;
  },
  async getVersionStatus(): Promise<string> {
    return JSON.stringify({} as VersionStatus);
  },
  sendTestNotification(): void {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  getPathForFile(file: File): string {
    return file.name;
  },
  onProgress(): void {
    // Do Nothing
  },

  // Server Kifu (LAN only)
  async isServerKifuEnabled(): Promise<boolean> {
    try {
      const json = await parseJsonResponse<{ enabled: boolean }>(
        await apiClient.api.kifu.enabled.$get(),
      );
      return !!json.enabled;
    } catch {
      return false;
    }
  },
  async listServerKifu(dir?: string, reload?: boolean): Promise<KifuListEntry[]> {
    return await parseJsonResponse<KifuListEntry[]>(
      await apiClient.api.kifu.list.$get({
        query: { dir, reload: reload ? "true" : "" },
      }),
    );
  },
  async searchServerKifu(params: {
    sfen?: string;
    keyword?: string;
    player1?: string;
    player2?: string;
    isStrictTurn?: boolean;
    startDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<KifuSearchResult[]> {
    const response = await apiClient.api.kifu.search.$get({
      query: {
        sfen: params.sfen,
        keyword: params.keyword,
        player1: params.player1,
        player2: params.player2,
        isStrictTurn: params.isStrictTurn ? "true" : "",
        startDate: params.startDate,
        limit: params.limit,
        offset: params.offset,
      },
    });
    return await parseJsonResponse<KifuSearchResult[]>(response);
  },
  async countServerKifu(params: KifuSearchQuery): Promise<number> {
    const response = await apiClient.api.kifu.search.count.$get({
      query: toKifuSearchQuery(params),
    });
    return (await parseJsonResponse<{ count: number }>(response)).count;
  },
  async startServerKifuSfenExport(params: SfenExportRequest): Promise<SfenExportJobStatus> {
    return await parseJsonResponse(await apiClient.api.kifu.export.sfen.$post({ json: params }));
  },
  async getServerKifuSfenExport(jobId: string): Promise<SfenExportJobStatus> {
    return await parseJsonResponse(
      await apiClient.api.kifu.export.sfen[":jobId"].$get({ param: { jobId } }),
    );
  },
  async cancelServerKifuSfenExport(jobId: string): Promise<void> {
    await assertOkResponse(
      await apiClient.api.kifu.export.sfen[":jobId"].$delete({ param: { jobId } }),
    );
  },
  async getServerKifuIndexStatus(): Promise<{
    total: number;
    indexed: number;
    isIndexing: boolean;
  }> {
    return await parseJsonResponse(await apiClient.api.kifu.index.status.$get());
  },
  async listServerBook(): Promise<string[]> {
    return await parseJsonResponse(await apiClient.api.book.list.$get());
  },
  async listServerPosition(): Promise<string[]> {
    return await parseJsonResponse(await apiClient.api.sfen.list.$get());
  },
  async loadServerKifu(path: string): Promise<string> {
    const response = await apiClient.api.kifu.get.$get({ query: { path } });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const data = await response.arrayBuffer();
    const fileURI = "server://" + path;
    fileCache.set(fileURI, data);
    return fileURI;
  },
  async saveServerKifu(path: string, data: Uint8Array): Promise<void> {
    const response = await apiClient.api.kifu.save.$post(
      { query: { path } },
      apiOptions({
        headers: { "Content-Type": "application/octet-stream" },
        body: data as unknown as BodyInit,
      }),
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
};
