import {
  ImmutableRecord,
  importKIF,
  Record,
  RecordMetadataKey,
  exportJKFString,
  importJKFString,
  areSameMoves,
  Move,
} from "tsshogi";
import { useErrorStore } from "./error.js";
import { isMobileWebApp, isNative } from "@/renderer/ipc/api.js";

const mobileRecordStorageKey = "mobile:record";
const mobilePlyStorageKey = "mobile:ply";
const webAppUsenStorageKey = "webapp:usen";
const webAppJKFStorageKey = "webapp:jkf";
const webAppBranchStorageKey = "webapp:branch";
const webAppPlyStorageKey = "webapp:ply";

export function loadRecordForWebApp(): Record | undefined {
  if (isNative()) {
    return;
  }

  const urlParams = new URL(window.location.toString()).searchParams;
  const usen = urlParams.get("usen");
  if (usen) {
    const branch = parseInt(urlParams.get("branch") || "0", 10);
    const ply = parseInt(urlParams.get("ply") || "0", 10);
    const record = Record.newByUSEN(usen, branch, ply);
    if (record instanceof Error) {
      useErrorStore().add(`棋譜の読み込み中にエラーが発生しました。: ${record}`);
      return;
    }
    const bname = urlParams.get("bname") || "";
    const wname = urlParams.get("wname") || "";
    record.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, bname);
    record.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, wname);
    return record;
  }

  const storedJKF = localStorage.getItem(webAppJKFStorageKey);
  const storedUsen = localStorage.getItem(webAppUsenStorageKey);
  const branch = parseInt(localStorage.getItem(webAppBranchStorageKey) || "0", 10);
  const ply = parseInt(localStorage.getItem(webAppPlyStorageKey) || "0", 10);

  if (storedJKF && storedUsen) {
    const record = Record.newByUSEN(storedUsen, branch, ply);
    const dataRecord = importJKFString(storedJKF);
    if (!(record instanceof Error) && !(dataRecord instanceof Error)) {
      // USENレコードからルートからの指し手パスを取得して、JKFレコード上でそのパスを再現する。
      // これにより、merge() のバグ（USEN内の不備が他のブランチに波及する問題）を回避しつつ、
      // ユーザーが選択していたブランチ（SpecialMoveを含む）を正確に復元できる。
      const path = record.movesBefore;
      let current = dataRecord.first;

      for (let i = 1; i < path.length; i++) {
        const targetMove = path[i].move;
        let child = current.next;

        let found = false;
        while (child) {
          const moveA = child.move;
          const moveB = targetMove;

          if (
            areSameMoves(moveA, moveB) ||
            (moveA instanceof Move && moveB instanceof Move && moveA.usi === moveB.usi) ||
            (!(moveA instanceof Move) && !(moveB instanceof Move) && moveA.type === moveB.type)
          ) {
            current = child;
            found = true;
            break;
          }
          child = child.branch;
        }
        if (!found) {
          break;
        }
      }

      dataRecord.gotoNode(current);

      // 最後に指定の手数へ移動（pathが途切れていた場合のため）
      dataRecord.goto(ply);
      return dataRecord;
    }
  }

  if (storedJKF) {
    const record = importJKFString(storedJKF);
    if (!(record instanceof Error)) {
      record.switchBranchByIndex(branch);
      record.goto(ply);
      return record;
    }
  }

  if (!isMobileWebApp()) {
    return;
  }

  const data = localStorage.getItem(mobileRecordStorageKey);
  if (data === null) {
    return;
  }
  const record = importKIF(data);
  if (record instanceof Error) {
    return;
  }
  const mobilePly = Number.parseInt(localStorage.getItem(mobilePlyStorageKey) || "0");
  record.goto(mobilePly);
  return record;
}

function hasUSENParam(): boolean {
  const urlParams = new URL(window.location.toString()).searchParams;
  return !!urlParams.get("usen");
}

let saveTimeout: number | undefined;

export function saveRecordForWebApp(record: ImmutableRecord): void {
  if (isNative()) {
    return;
  }
  if (hasUSENParam()) {
    return;
  }
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = window.setTimeout(() => {
    const jkf = exportJKFString(record);
    const [usen, branch] = record.usen;
    localStorage.setItem(webAppJKFStorageKey, jkf);
    localStorage.setItem(webAppUsenStorageKey, usen);
    localStorage.setItem(webAppBranchStorageKey, (branch || 0).toString());
    localStorage.setItem(webAppPlyStorageKey, record.current.ply.toString());
  }, 300);
}

export function clearURLParams(): void {
  const url = new URL(window.location.toString());
  url.searchParams.delete("usen");
  url.searchParams.delete("branch");
  url.searchParams.delete("ply");
  url.searchParams.delete("bname");
  url.searchParams.delete("wname");
  window.history.replaceState({}, "", url.toString());
}
