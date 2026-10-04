import { Language } from "./languages";

const messages = {
  [Language.JA]: {
    invalid: "対局の入力または応答が不正です。",
    expired: "対局セッションが失効したか、サーバーが再起動しました。自動的には再対局しません。",
    conflict: "対局状態が更新されました。同期後に操作をやり直してください。",
    engine: "対局エンジンとの通信が失敗しました。棋譜は保持されています。",
    capacity: "対局の実行または棋譜サイズの上限に達しました。",
    save: "対局棋譜の保存に失敗しました。次局へ進みます。",
    recover: "サーバー上の対局棋譜を開きますか？ 現在の棋譜は別の内容です。",
    externalBook: "外部定跡",
  },
  [Language.EN]: {
    invalid: "Invalid game input or response.",
    expired: "The game expired or the server restarted. It will not restart automatically.",
    conflict: "The game state changed. Synchronize before retrying the operation.",
    engine: "The game engine failed. The record has been retained.",
    capacity: "The game execution or record size limit has been reached.",
    save: "Game record saving failed. Continuing to the next game.",
    recover: "Open the server game record? The current record differs.",
    externalBook: "External book",
  },
};
export const gameTexts = (language: Language = Language.JA) =>
  messages[language === Language.JA ? Language.JA : Language.EN];
