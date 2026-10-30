import "./css/font.css";
import "./css/color.css";
import "./css/basic.css";
import "./css/control.css";
import "./css/dialog.css";
import { createApp, watch } from "vue";
import App from "@/renderer/App.vue";
import api, { appInfo, isMobileWebApp } from "@/renderer/ipc/api";
import { useStore } from "@/renderer/store/index";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
} from "chart.js";
import { LogLevel } from "@/common/log";
import { useAppSettings } from "./store/settings.js";
import { setLanguage, t } from "@/common/i18n/index";
import { default as dayjs } from "dayjs";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _en from "dayjs/locale/en";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _ja from "dayjs/locale/ja";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _zh_tw from "dayjs/locale/zh-tw";
import relativeTime from "dayjs/plugin/relativeTime";
import { useErrorStore } from "@/renderer/store/error";
import { UIMode } from "@/common/settings/app";
// eslint-disable-next-line import-x/no-unresolved
import { registerSW } from "virtual:pwa-register";
import { setupPwaUpdates } from "@/renderer/webapp/update";

api.log(LogLevel.INFO, `start renderer process: APP_VERSION=${appInfo.appVersion}`);
useStore().prepareJobNavigation();
window.addEventListener("pagehide", () => useStore().suspendJobs());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

// setup libraries
import("dayjs/locale/en");
import("dayjs/locale/ja");
import("dayjs/locale/zh-tw");
dayjs.extend(relativeTime);
Chart.register(
  ScatterController,
  LineElement,
  LinearScale,
  PointElement,
  CategoryScale,
  Legend,
  BarController,
  BarElement,
  Tooltip,
);

const store = useStore();

// サーバー側の棋譜管理機能が有効かどうかを確認する。
api.isServerKifuEnabled().then((enabled) => {
  store.updateServerSideKifuEnabled(enabled);
});

// ファイル名の変更を監視してタイトルを更新する。
function updateTitle(path: string | undefined, unsaved: boolean) {
  if (!document) {
    return;
  }
  const appName = t.shogiHomeLab;
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
        /Windows|Mac|Linux/.test(navigator.userAgent) &&
        !/Android|iPhone/.test(navigator.userAgent);
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
  const disposePwaUpdates = setupPwaUpdates(registerSW);
  window.addEventListener("pagehide", disposePwaUpdates, { once: true });
  void store.initializeJobs();
});
