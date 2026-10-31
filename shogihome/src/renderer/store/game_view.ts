import { type AppSettings, buildUpdatedAppSettings } from "@/common/settings/app";

export type GameViewSettings = Pick<
  AppSettings,
  | "tab"
  | "tab2"
  | "topPaneHeightPercentage"
  | "topPanePreviousHeightPercentage"
  | "bottomLeftPaneWidthPercentage"
  | "showCommentInRecordView"
>;

function viewSettings(settings: AppSettings): GameViewSettings {
  return {
    tab: settings.tab,
    tab2: settings.tab2,
    topPaneHeightPercentage: settings.topPaneHeightPercentage,
    topPanePreviousHeightPercentage: settings.topPanePreviousHeightPercentage,
    bottomLeftPaneWidthPercentage: settings.bottomLeftPaneWidthPercentage,
    showCommentInRecordView: settings.showCommentInRecordView,
  };
}

// Game-only display changes never overwrite the user's ordinary layout.
export class GameViewState {
  settings?: GameViewSettings;

  setActive(active: boolean, app: AppSettings): void {
    if (!active) {
      this.settings = undefined;
    } else if (!this.settings) {
      this.settings = viewSettings(
        buildUpdatedAppSettings(app, {
          topPaneHeightPercentage: 100,
          showCommentInRecordView: false,
        }),
      );
    }
  }

  update(app: AppSettings, update: Partial<GameViewSettings>): boolean {
    if (!this.settings) return false;
    this.settings = viewSettings(buildUpdatedAppSettings({ ...app, ...this.settings }, update));
    return true;
  }
}
