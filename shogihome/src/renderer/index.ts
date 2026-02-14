import "./css/font.css";
import "./css/color.css";
import "./css/basic.css";
import "./css/control.css";
import "./css/dialog.css";
import { createApp, watch } from "vue";
import App from "@/renderer/App.vue";
import api, { appInfo, isMobileWebApp, isNative } from "@/renderer/ipc/api.js";
import { setup as setupIPC } from "@/renderer/ipc/setup.js";
import { useStore } from "@/renderer/store/index.js";
import {
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  ScatterController,
} from "chart.js";
import { LogLevel } from "@/common/log.js";
import { useAppSettings } from "./store/settings.js";
import { setLanguage, t } from "@/common/i18n/index.js";
import { default as dayjs } from "dayjs";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _en from "dayjs/locale/en";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _ja from "dayjs/locale/ja";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _zh_tw from "dayjs/locale/zh-tw";
import relativeTime from "dayjs/plugin/relativeTime";
import { useErrorStore } from "@/renderer/store/error.js";
import { UIMode } from "@/common/settings/app.js";

api.log(LogLevel.INFO, `start renderer process: APP_VERSION=${appInfo.appVersion}`);

// setup libraries
import("dayjs/locale/en");
import("dayjs/locale/ja");
import("dayjs/locale/zh-tw");
dayjs.extend(relativeTime);
Chart.register(ScatterController, LineElement, LinearScale, PointElement, CategoryScale, Legend);

setupIPC();

const store = useStore();

// サーバー側の棋譜管理機能が有効かどうかを確認する。
if (!isNative()) {
  api.isServerKifuEnabled().then((enabled) => {
    store.updateServerSideKifuEnabled(enabled);
  });
}

// ファイル名の変更を監視してタイトルを更新する。
function updateTitle(path: string | undefined, unsaved: boolean) {
  if (!document) {
    return;
  }
  const appName = t.shogiHomeLAN;
  const appVersion = appInfo.appVersion;
  if (isMobileWebApp()) {
    document.title = `${appName} Version ${appVersion} for Mobile Web Browser`;
    return;
  }
  if (path || unsaved) {
    const unsavedMaker = unsaved ? `${t.unsaved}: ` : "";
    const name = path ? path : t.newRecord;
    document.title = `${appName} Version ${appVersion} - ${unsavedMaker}${name}`;
  } else {
    document.title = `${appName} Version ${appVersion}`;
  }
}
watch(
  [() => store.recordFilePath, () => store.serverKifuPath, () => store.isRecordFileUnsaved],
  ([path, serverPath, unsaved]) => {
    updateTitle(path || serverPath, unsaved);
  },
);

Promise.allSettled([
  // アプリ設定の読み込み
  useAppSettings()
    .loadAppSettings()
    .catch((e) => {
      useErrorStore().add(new Error("アプリ設定の読み込み中にエラーが発生しました: " + e));
    }),
  // 起動時パラメータで指定された棋譜の読み込み
  api
    .fetchInitialRecordFileRequest()
    .then((request) => {
      if (request) {
        store.openRecord(request.path, {
          ply: request.ply,
        });
      }
    })
    .catch((e) => {
      useErrorStore().add(new Error("起動パラメーターの取得に失敗しました: " + e));
    }),
]).finally(() => {
  // UIモードの強制切り替え
  const appSettings = useAppSettings();
  const url = new URL(window.location.href);
  const hasMobileParam = isMobileWebApp();
  let reload = false;
  switch (appSettings.uiMode) {
    case UIMode.PC:
      if (hasMobileParam) {
        url.searchParams.delete("mobile");
        reload = true;
      }
      break;
    case UIMode.MOBILE:
      if (!hasMobileParam) {
        url.searchParams.set("mobile", "");
        reload = true;
      }
      break;
    case UIMode.AUTO:
    default:
      // eslint-disable-next-line no-case-declarations
      const isPC =
        /Windows|Mac|Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
      if (!isPC && !hasMobileParam) {
        url.searchParams.set("mobile", "");
        reload = true;
      }
      break;
  }
  if (reload) {
    window.location.replace(url.href);
    return; // リロードするので以降の処理は不要
  }

  // 言語設定の反映
  const language = useAppSettings().language;
  api.log(LogLevel.INFO, `set language: ${language}`);
  setLanguage(language);

  // タイトルの更新
  updateTitle(store.recordFilePath || store.serverKifuPath, store.isRecordFileUnsaved);

  api.log(LogLevel.INFO, "mount app");
  createApp(App).mount("#app");
});
