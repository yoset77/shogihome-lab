import { BookLoadingMode, BookMove, BookMoveEx, defaultBookSession } from "@/common/book.js";
import { reactive, UnwrapNestedRefs } from "vue";
import api from "@/renderer/ipc/api.js";
import { useErrorStore } from "./error.js";
import { useBusyState } from "./busy.js";
import { useMessageStore } from "./message.js";
import { useAppSettings } from "./settings.js";
import { useConfirmationStore } from "./confirm.js";
import { BookImportSettings, SourceType } from "@/common/settings/book.js";
import { t } from "@/common/i18n/index.js";
import { ImmutableRecord } from "tsshogi";
import { flippedSFEN, flippedUSIMove } from "@/common/helpers/sfen.js";
import { Lazy } from "@/renderer/helpers/lazy.js";

export class BookStore {
  private _mode: BookLoadingMode = "in-memory";
  private _path: string | undefined;
  private _moves: BookMoveEx[] = [];
  private _lazy = new Lazy();
  private _reactive: UnwrapNestedRefs<BookStore>;
  private _onShowBookSelectDialog?: () => void;

  constructor(private record: ImmutableRecord) {
    this._reactive = reactive(this);
  }

  get reactive(): UnwrapNestedRefs<BookStore> {
    return this._reactive;
  }

  get mode(): BookLoadingMode {
    return this._mode;
  }

  get path(): string | undefined {
    return this._path;
  }

  get moves(): BookMoveEx[] {
    return this._moves;
  }

  onShowBookSelectDialog(handler: () => void) {
    this._onShowBookSelectDialog = handler;
  }

  async reloadBookMoves() {
    try {
      const sfen = this.record.position.sfen;
      const moves = await this.searchMoves(sfen);
      if (sfen !== this.record.position.sfen) {
        return;
      }
      this._moves = moves.map((bookMove) => {
        const position = this.record.position.clone();
        const move = position.createMoveByUSI(bookMove.usi);
        let repetition = 0;
        if (move) {
          position.doMove(move);
          repetition = this.record.getRepetitionCount(position);
        }
        return {
          ...bookMove,
          repetition,
        } as BookMoveEx;
      });
    } catch (e) {
      useErrorStore().add(e);
    }
  }

  onChangePosition(record: ImmutableRecord) {
    this.record = record;
    this._moves = [];
    this._lazy.after(() => {
      this.reloadBookMoves();
    }, 200);
  }

  reset() {
    if (useBusyState().isBusy) {
      return;
    }
    useConfirmationStore().show({
      message: t.anyUnsavedDataWillBeLostDoYouReallyWantToResetBookData,
      onOk: () => {
        useBusyState().retain();
        api
          .clearBook(defaultBookSession)
          .then(() => {
            this._mode = "in-memory";
            this._path = undefined;
            return this.reloadBookMoves();
          })
          .catch((e) => {
            useErrorStore().add(e);
          })
          .finally(() => {
            useBusyState().release();
          });
      },
    });
  }

  async openBookFile() {
    useBusyState().retain();
    try {
      const enabled = await api.isServerKifuEnabled();
      if (enabled) {
        if (this._onShowBookSelectDialog) {
          this._onShowBookSelectDialog();
        }
      } else {
        const path = await api.showOpenBookDialog();
        if (path) {
          await this.openBook(path);
        }
      }
    } catch (e) {
      useErrorStore().add(e);
    } finally {
      useBusyState().release();
    }
  }

  async openBook(path: string) {
    try {
      const mode = await api.openBook(defaultBookSession, path, {
        onTheFlyThresholdMB: useAppSettings().bookOnTheFlyThresholdMB,
      });
      this._mode = mode;
      this._path = path;
      await this.reloadBookMoves();
    } catch (e) {
      useErrorStore().add(e);
      throw e;
    }
  }

  saveBookFile() {
    if (useBusyState().isBusy) {
      return;
    }
    if (this._mode === "in-memory" && this._path?.startsWith("server://")) {
      useBusyState().retain();
      api
        .saveBook(defaultBookSession, this._path)
        .then(() => {
          useMessageStore().enqueue({ text: t.bookDataWasSaved });
        })
        .catch((e) => {
          useErrorStore().add(e);
        })
        .finally(() => {
          useBusyState().release();
        });
      return;
    }
    useBusyState().retain();
    const defaultPath = this._path?.startsWith("server://")
      ? this._path.substring(9)
      : "new_book.db";
    api
      .showSaveBookDialog(defaultBookSession, defaultPath)
      .then(async (path) => {
        if (path) {
          await api.saveBook(defaultBookSession, path);
          this._path = path;
          useMessageStore().enqueue({ text: t.bookDataWasSaved });
        }
      })
      .catch((e) => {
        useErrorStore().add(e);
      })
      .finally(() => {
        useBusyState().release();
      });
  }

  saveBookFileAs() {
    if (useBusyState().isBusy) {
      return;
    }
    useBusyState().retain();
    const defaultPath = this._path?.startsWith("server://")
      ? this._path.substring(9)
      : "new_book.db";
    api
      .showSaveBookDialog(defaultBookSession, defaultPath)
      .then(async (path) => {
        if (path) {
          await api.saveBook(defaultBookSession, path);
          this._path = path;
          useMessageStore().enqueue({ text: t.bookDataWasSaved });
        }
      })
      .catch((e) => {
        useErrorStore().add(e);
      })
      .finally(() => {
        useBusyState().release();
      });
  }

  async updateMove(sfen: string, move: BookMove) {
    useBusyState().retain();
    return api
      .updateBookMove(defaultBookSession, sfen, move)
      .then(() => this.reloadBookMoves())
      .then(async () => {
        const settings = await api.loadBookImportSettings();
        settings.sourceType = SourceType.MEMORY;
        await api.saveBookImportSettings(settings);
      })
      .finally(() => {
        useBusyState().release();
      });
  }

  removeMove(sfen: string, usi: string) {
    useBusyState().retain();
    api
      .removeBookMove(defaultBookSession, sfen, usi)
      .then(() => this.reloadBookMoves())
      .catch((e) => {
        useErrorStore().add(e);
      })
      .finally(() => {
        useBusyState().release();
      });
  }

  updateMoveOrder(sfen: string, usi: string, order: number) {
    useBusyState().retain();
    api
      .updateBookMoveOrder(defaultBookSession, sfen, usi, order)
      .then(() => this.reloadBookMoves())
      .catch((e) => {
        useErrorStore().add(e);
      })
      .finally(() => {
        useBusyState().release();
      });
  }

  async searchMoves(sfen: string): Promise<BookMove[]> {
    const moves = await api.searchBookMoves(defaultBookSession, sfen);
    if (moves.length !== 0) {
      return moves;
    }
    const appSettings = useAppSettings();
    if (!appSettings.flippedBook) {
      return [];
    }
    return (await api.searchBookMoves(defaultBookSession, flippedSFEN(sfen))).map((move) => {
      move.usi = flippedUSIMove(move.usi);
      if (move.usi2) {
        move.usi2 = flippedUSIMove(move.usi2);
      }
      return move;
    });
  }

  async searchMovesBatch(sfens: string[]): Promise<Map<string, BookMove[]>> {
    const appSettings = useAppSettings();
    const querySfens = [...sfens];
    if (appSettings.flippedBook) {
      sfens.forEach((sfen) => querySfens.push(flippedSFEN(sfen)));
    }

    const results = await api.searchBookMovesBatch(defaultBookSession, querySfens);
    const resultMap = new Map<string, BookMove[]>();
    results.forEach((r) => resultMap.set(r.sfen, r.moves));

    const finalMap = new Map<string, BookMove[]>();
    sfens.forEach((sfen) => {
      const moves = resultMap.get(sfen) || [];
      if (moves.length > 0) {
        finalMap.set(sfen, moves);
      } else if (appSettings.flippedBook) {
        const flipped = flippedSFEN(sfen);
        const flippedMoves = (resultMap.get(flipped) || []).map((move) => {
          const m = { ...move };
          m.usi = flippedUSIMove(m.usi);
          if (m.usi2) {
            m.usi2 = flippedUSIMove(m.usi2);
          }
          return m;
        });
        finalMap.set(sfen, flippedMoves);
      } else {
        finalMap.set(sfen, []);
      }
    });
    return finalMap;
  }

  importBookMoves(settings: BookImportSettings) {
    useBusyState().retain();
    api
      .saveBookImportSettings(settings)
      .then(() => api.importBookMoves(defaultBookSession, settings))
      .then((summary) => {
        const items = [
          {
            text: t.file,
            children: [
              `${t.success}: ${summary.successFileCount}`,
              `${t.failed}: ${summary.errorFileCount}`,
              `${t.skipped}: ${summary.skippedFileCount}`,
            ],
          },
        ];
        if (summary.entryCount !== undefined && summary.duplicateCount !== undefined) {
          items.push({
            text: t.moveEntry,
            children: [
              `${t.new}: ${summary.entryCount}`,
              `${t.duplicated}: ${summary.duplicateCount}`,
            ],
          });
        }
        useMessageStore().enqueue({
          text: t.bookMovesWereImported,
          attachments: [{ type: "list", items }],
        });
        return this.reloadBookMoves();
      })
      .catch((e) => {
        useErrorStore().add(e);
      })
      .finally(() => {
        useBusyState().release();
      });
  }
}

let store: UnwrapNestedRefs<BookStore>;

export function useBookStore(record?: ImmutableRecord): UnwrapNestedRefs<BookStore> {
  if (!store) {
    if (!record) {
      throw new Error("BookStore must be initialized with a record.");
    }
    store = new BookStore(record).reactive;
  }
  return store;
}
