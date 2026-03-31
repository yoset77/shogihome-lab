/* eslint-disable no-console */
import { defaultAnalysisSettings } from "@/common/settings/analysis.js";
import { defaultAppSettings } from "@/common/settings/app.js";
import { defaultGameSettings } from "@/common/settings/game.js";
import { defaultResearchSettings } from "@/common/settings/research.js";
import { USIEngines } from "@/common/settings/usi.js";
import { LogLevel } from "@/common/log.js";
import { Bridge } from "@/renderer/ipc/bridge.js";
import { t } from "@/common/i18n/index.js";
import { defaultCSAGameSettingsHistory } from "@/common/settings/csa.js";
import { defaultMateSearchSettings } from "@/common/settings/mate.js";
import { defaultBatchConversionSettings } from "@/common/settings/conversion.js";
import { defaultBookImportSettings } from "@/common/settings/book.js";
import { getEmptyHistory } from "@/common/file/history.js";
import { BookLoadingMode } from "@/common/book.js";
import { VersionStatus } from "@/common/version.js";
import { SessionStates } from "@/common/advanced/monitor.js";
import { emptyLayoutProfileList } from "@/common/settings/layout.js";
import * as uri from "@/common/uri.js";
import { normalizePath } from "@/common/helpers/path.js";
import { convert } from "encoding-japanese";

enum STORAGE_KEY {
  APP_SETTINGS = "appSetting",
  RESEARCH_SETTINGS = "researchSetting",
  BATCH_CONVERSION_SETTINGS = "batchConversionSetting",
  ANALYSIS_SETTINGS = "analysisSetting",
  GAME_SETTINGS = "gameSetting",
  MATE_SEARCH_SETTINGS = "mateSearchSetting",
  CSA_GAME_SETTINGS_HISTORY = "csaGameSettingHistory",
  BOOK_IMPORT_SETTINGS = "bookImportSetting",
}

const fileCache = new Map<string, ArrayBuffer>();

import { generateSessionId } from "@/renderer/helpers/unique.js";

const webBookSessionId = generateSessionId();

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000,
  sessionId?: string,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);

  const headers = new Headers(init?.headers);
  headers.set("X-Book-Session-Id", sessionId || webBookSessionId);

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
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
  async loadCSAGameSettingsHistory(): Promise<string> {
    const json = localStorage.getItem(STORAGE_KEY.CSA_GAME_SETTINGS_HISTORY);
    if (!json) {
      return JSON.stringify(defaultCSAGameSettingsHistory());
    }
    return JSON.stringify({
      ...defaultCSAGameSettingsHistory(),
      ...JSON.parse(json),
    });
  },
  async saveCSAGameSettingsHistory(json: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY.CSA_GAME_SETTINGS_HISTORY, json);
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
    return JSON.stringify({
      ...defaultBookImportSettings(),
      ...JSON.parse(json),
    });
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
      const response = await fetchWithTimeout(`/api/kifu/get?path=${encodeURIComponent(relPath)}`);
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
      const response = await fetchWithTimeout("/api/history");
      if (response.ok) {
        const data = await response.json();
        return JSON.stringify(data);
      }
    } catch (e) {
      // Ignore errors silently as backup is an auxiliary feature
    }
    return JSON.stringify(getEmptyHistory());
  },
  addRecordFileHistory(path: string): void {
    if (path.startsWith(uri.ES_TEMP_FILE_PREFIX)) {
      const data = fileCache.get(path);
      if (data) {
        const kif = convert(new Uint8Array(data), { to: "UNICODE", type: "string" });
        this.saveRecordFileBackup(kif);
      }
      return;
    }
    fetchWithTimeout("/api/history/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    }).catch(() => {
      // Ignore errors silently
    });
  },
  async clearRecordFileHistory(): Promise<void> {
    try {
      await fetchWithTimeout("/api/history/clear", { method: "POST" });
    } catch (e) {
      // Ignore errors
    }
  },
  async saveRecordFileBackup(kif: string): Promise<void> {
    try {
      await fetchWithTimeout("/api/history/backup", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: kif,
      });
    } catch (e) {
      // Ignore errors silently
    }
  },
  async loadRecordFileBackup(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async loadRemoteTextFile(url: string): Promise<string> {
    const response = await fetchWithTimeout(`/api/fetch-remote?url=${encodeURIComponent(url)}`);
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
    const response = await fetchWithTimeout(`/api/sfen/load?path=${encodeURIComponent(relPath)}`);
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
    const response = await fetchWithTimeout("/api/kifu/enabled");
    const json = await response.json();
    if (!json.enabled) {
      throw new Error(t.thisFeatureNotAvailableOnWebApp);
    }
    // Return a dummy path to trigger the server-side openBook.
    // The actual path will be selected from the kifu list in the UI.
    return "server://";
  },
  async showSaveBookDialog(defaultPath: string): Promise<string> {
    const response = await fetchWithTimeout("/api/kifu/enabled");
    const json = await response.json();
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
    const response = await fetchWithTimeout(
      `/api/book/open?path=${encodeURIComponent(relPath)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: options,
      },
      60000,
      sessionId,
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
    const response = await fetchWithTimeout(
      `/api/book/save?path=${encodeURIComponent(relPath)}`,
      {
        method: "POST",
      },
      600000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async closeBookSession(sessionId: string): Promise<void> {
    const response = await fetchWithTimeout(
      "/api/book/close",
      { method: "POST" },
      10000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async clearBook(sessionId?: string): Promise<void> {
    const response = await fetchWithTimeout(
      "/api/book/clear",
      { method: "POST" },
      10000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async searchBookMoves(sfen: string, sessionId?: string): Promise<string> {
    const response = await fetchWithTimeout(
      `/api/book/search?sfen=${encodeURIComponent(sfen)}`,
      undefined,
      10000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return JSON.stringify(json);
  },
  async searchBookMovesBatch(sfens: string[], sessionId?: string): Promise<string> {
    const response = await fetchWithTimeout(
      "/api/book/search/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sfens }),
      },
      60000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const json = await response.json();
    return JSON.stringify(json);
  },
  async updateBookMove(sfen: string, move: string, sessionId?: string): Promise<void> {
    const response = await fetchWithTimeout(
      `/api/book/update?sfen=${encodeURIComponent(sfen)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: move,
      },
      10000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async removeBookMove(sfen: string, usi: string, sessionId?: string): Promise<void> {
    const response = await fetchWithTimeout(
      `/api/book/remove?sfen=${encodeURIComponent(sfen)}&usi=${encodeURIComponent(usi)}`,
      { method: "POST" },
      10000,
      sessionId,
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
    const response = await fetchWithTimeout(
      `/api/book/order?sfen=${encodeURIComponent(sfen)}&usi=${encodeURIComponent(usi)}&order=${order}`,
      { method: "POST" },
      10000,
      sessionId,
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
  async importBookMoves(json: string, sessionId?: string): Promise<string> {
    const response = await fetchWithTimeout(
      "/api/book/import",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
      },
      600000,
      sessionId,
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

  // CSA
  async csaLogin(): Promise<number> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async csaLogout(): Promise<void> {
    // Do Nothing
  },
  async csaAgree(): Promise<void> {
    // Do Nothing
  },
  async csaMove(): Promise<void> {
    // Do Nothing
  },
  async csaResign(): Promise<void> {
    // Do Nothing
  },
  async csaWin(): Promise<void> {
    // Do Nothing
  },
  async csaStop(): Promise<void> {
    // Do Nothing
  },
  onCSAGameSummary(): void {
    // Do Nothing
  },
  onCSAReject(): void {
    // Do Nothing
  },
  onCSAStart(): void {
    // Do Nothing
  },
  onCSAMove(): void {
    // Do Nothing
  },
  onCSAGameResult(): void {
    // Do Nothing
  },
  onCSAClose(): void {
    // Do Nothing
  },

  // Sessions
  async collectSessionStates(): Promise<string> {
    return JSON.stringify({
      usiSessions: [],
      csaSessions: [],
    } as SessionStates);
  },
  async setupPrompt(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async openPrompt() {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  invokePromptCommand(): void {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  onPromptCommand(): void {
    // Do Nothing
  },

  // Images
  async showSelectImageDialog(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async cropPieceImage(): Promise<string> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async exportCaptureAsPNG(): Promise<void> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },
  async exportCaptureAsJPEG(): Promise<void> {
    throw new Error(t.thisFeatureNotAvailableOnWebApp);
  },

  // Layout
  async loadLayoutProfileList(): Promise<[string, string]> {
    return [uri.ES_STANDARD_LAYOUT_PROFILE, JSON.stringify(emptyLayoutProfileList())];
  },
  updateLayoutProfileList(): void {
    // Do Nothing
  },
  onUpdateLayoutProfileList(): void {
    // Do Nothing
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
      const response = await fetchWithTimeout("/api/kifu/enabled");
      const json = await response.json();
      return !!json.enabled;
    } catch (e) {
      return false;
    }
  },
  async listServerKifu(reload?: boolean): Promise<string[]> {
    const response = await fetchWithTimeout(`/api/kifu/list${reload ? "?reload=true" : ""}`);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return await response.json();
  },
  async listServerBook(): Promise<string[]> {
    const response = await fetchWithTimeout("/api/book/list");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return await response.json();
  },
  async listServerPosition(): Promise<string[]> {
    const response = await fetchWithTimeout("/api/sfen/list");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return await response.json();
  },
  async loadServerKifu(path: string): Promise<string> {
    const response = await fetchWithTimeout(`/api/kifu/get?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const data = await response.arrayBuffer();
    const fileURI = "server://" + path;
    fileCache.set(fileURI, data);
    return fileURI;
  },
  async saveServerKifu(path: string, data: Uint8Array): Promise<void> {
    const response = await fetchWithTimeout(`/api/kifu/save?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: data as any,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
  },
};
