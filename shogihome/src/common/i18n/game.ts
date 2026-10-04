import { Language } from "./languages";

const messages = {
  [Language.JA]: {
    invalid: "対局の入力または応答が不正です。",
    expired: "対局セッションが失効したか、サーバーが再起動しました。自動的には再対局しません。",
    conflict: "対局状態が更新されました。同期後に操作をやり直してください。",
    engine: "対局エンジンとの通信が失敗しました。棋譜は保持されています。",
    capacity: "対局または未保存棋譜の保持上限に達しました。",
    save: "対局棋譜の自動保存に失敗しました。棋譜を保持して次局へ進みます。",
    recover: "サーバー上の対局棋譜を開きますか？ 現在の棋譜は別の内容です。",
    reconnecting: "対局状態を再同期しています。",
    paused: "人間手番で停止中",
    retrySave: "未保存対局を再保存",
    recoverAction: "対局を復元",
    retainedRecords: "保持中の対局棋譜",
    externalBook: "外部定跡",
    saved: "保存済み",
    unsaved: "未保存",
    failed: "保存失敗",
    forget: "対局の復元情報を解除",
    forgetConfirm:
      "対局の復元情報を解除しますか？ 未保存棋譜を先に取り出してください。サーバー再起動・保持期限後は取り出せません。",
  },
  [Language.EN]: {
    invalid: "Invalid game input or response.",
    expired: "The game expired or the server restarted. It will not restart automatically.",
    conflict: "The game state changed. Synchronize before retrying the operation.",
    engine: "The game engine failed. The record has been retained.",
    capacity: "The game or unsaved record limit has been reached.",
    save: "Automatic game saving failed. The record is retained and the next game continues.",
    recover: "Open the server game record? The current record differs.",
    reconnecting: "Synchronizing the game.",
    paused: "Paused on the human turn",
    retrySave: "Retry saving retained games",
    recoverAction: "Recover game",
    retainedRecords: "Retained game records",
    externalBook: "External book",
    saved: "Saved",
    unsaved: "Unsaved",
    failed: "Save failed",
    forget: "Clear game recovery link",
    forgetConfirm:
      "Clear the game recovery link? Retrieve unsaved records first. Records are unavailable after a server restart or retention expiry.",
  },
};
export const gameTexts = (language: Language = Language.JA) =>
  messages[language === Language.JA ? Language.JA : Language.EN];
