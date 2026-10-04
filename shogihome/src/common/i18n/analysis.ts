import { Language } from "./languages";

const messages = {
  [Language.JA]: {
    engine: "棋譜解析中にエンジンとの通信が失敗しました。途中結果は保持されています。",
    expired: "解析ジョブが失効したか、サーバーが再起動しました。自動的には再実行しません。",
    capacity: "解析ジョブの上限に達しています。既存の解析が終了してから再試行してください。",
    invalid: "解析の入力または応答が不正です。",
    deadline: "解析の実行期限に達しました。途中結果は保持されています。",
    recover:
      "保持されている解析棋譜を開きますか？ 現在の棋譜は別の内容のため、自動反映できません。",
    cancelling: "解析の取消を確認中",
    reconnecting: "解析状態を再取得しています。サーバー上の解析は継続します。",
    progress: "解析進捗",
    recoverAction: "解析結果を復元",
  },
  [Language.EN]: {
    engine: "The analysis engine failed. Partial results have been retained.",
    expired: "The analysis job expired or the server restarted. It will not restart automatically.",
    capacity:
      "The analysis job limit has been reached. Retry after the existing analysis finishes.",
    invalid: "Invalid analysis input or response.",
    deadline: "The analysis time limit was reached. Partial results have been retained.",
    recover:
      "Open the retained analysis record? The current record differs and cannot be updated automatically.",
    cancelling: "Waiting for analysis cancellation",
    reconnecting: "Reconnecting to analysis. The server continues processing.",
    progress: "Analysis progress",
    recoverAction: "Recover analysis",
  },
  [Language.ZH_TW]: {
    engine: "分析引擎發生錯誤。已保留部分結果。",
    expired: "分析工作已失效或伺服器已重新啟動，不會自動重新執行。",
    capacity: "分析工作已達上限，請在現有分析結束後重試。",
    invalid: "分析輸入或回應無效。",
    deadline: "分析已達執行期限，已保留部分結果。",
    recover: "開啟保留的分析棋譜嗎？目前棋譜不同，無法自動套用結果。",
    cancelling: "正在確認取消分析",
    reconnecting: "正在重新取得分析狀態，伺服器上的分析會繼續。",
    progress: "分析進度",
    recoverAction: "復原分析結果",
  },
  [Language.VI]: {
    engine: "Công cụ phân tích gặp lỗi. Kết quả một phần đã được giữ lại.",
    expired: "Tác vụ phân tích hết hạn hoặc máy chủ đã khởi động lại. Không tự động chạy lại.",
    capacity: "Đã đạt giới hạn tác vụ. Hãy thử lại sau khi phân tích hiện tại kết thúc.",
    invalid: "Dữ liệu phân tích hoặc phản hồi không hợp lệ.",
    deadline: "Đã đạt thời hạn phân tích. Kết quả một phần đã được giữ lại.",
    recover: "Mở biên bản phân tích đã lưu? Biên bản hiện tại khác nên không thể tự động cập nhật.",
    cancelling: "Đang xác nhận hủy phân tích",
    reconnecting: "Đang kết nối lại. Máy chủ tiếp tục phân tích.",
    progress: "Tiến độ phân tích",
    recoverAction: "Khôi phục phân tích",
  },
};

export const analysisTexts = (language: Language = Language.JA) => messages[language];
