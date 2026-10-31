import { defaultAppSettings, Tab, TabPaneType } from "@/common/settings/app";
import { GameViewState } from "@/renderer/store/game_view";

describe("game view preset", () => {
  it("hides thinking without changing the ordinary settings", () => {
    const app = defaultAppSettings();
    const original = { ...app };
    const view = new GameViewState();
    view.setActive(true, app);
    expect(view.settings).toMatchObject({
      topPaneHeightPercentage: 100,
      topPanePreviousHeightPercentage: app.topPaneHeightPercentage,
      showCommentInRecordView: false,
    });
    expect(app).toEqual(original);
    view.setActive(false, app);
    expect(view.settings).toBeUndefined();
    expect(view.update(app, { tab: Tab.PV })).toBe(false);
  });

  it("keeps manual changes until the preset ends and starts hidden on the next game", () => {
    const app = defaultAppSettings();
    const view = new GameViewState();
    view.setActive(true, app);
    expect(
      view.update(app, {
        topPaneHeightPercentage: 55,
        showCommentInRecordView: true,
        tab: Tab.PV,
        bottomLeftPaneWidthPercentage: 40,
      }),
    ).toBe(true);
    view.setActive(true, app);
    expect(view.settings).toMatchObject({
      topPaneHeightPercentage: 55,
      showCommentInRecordView: true,
      tab: Tab.PV,
      bottomLeftPaneWidthPercentage: 40,
    });
    view.update(app, { topPaneHeightPercentage: 100 });
    expect(view.settings?.topPanePreviousHeightPercentage).toBe(55);
    view.setActive(false, app);
    view.setActive(true, app);
    expect(view.settings).toMatchObject({
      topPaneHeightPercentage: 100,
      showCommentInRecordView: false,
      tab: app.tab,
      bottomLeftPaneWidthPercentage: app.bottomLeftPaneWidthPercentage,
    });
  });

  it("preserves the expansion size when the ordinary tabs were already minimized", () => {
    const app = {
      ...defaultAppSettings(),
      topPaneHeightPercentage: 100,
      topPanePreviousHeightPercentage: 45,
      showCommentInRecordView: false,
    };
    const view = new GameViewState();
    view.setActive(true, app);
    expect(view.settings?.topPanePreviousHeightPercentage).toBe(45);
    view.update(app, { topPaneHeightPercentage: 45, showCommentInRecordView: true });
    view.setActive(false, app);
    expect(app.topPaneHeightPercentage).toBe(100);
    expect(app.showCommentInRecordView).toBe(false);
  });

  it.each([
    [TabPaneType.DOUBLE, { tab: Tab.COMMENT }, { tab: Tab.RECORD_INFO }],
    [TabPaneType.DOUBLE, { tab: Tab.CHART }, { tab: Tab.PV }],
    [TabPaneType.DOUBLE_V2, { tab: Tab.PERCENTAGE_CHART }, { tab: Tab.PV }],
    [TabPaneType.DOUBLE_V2, { tab: Tab.PV, tab2: Tab.COMMENT }, { tab: Tab.PV, tab2: Tab.CHART }],
    [
      TabPaneType.SINGLE,
      { tab: Tab.SEARCH, tab2: Tab.PERCENTAGE_CHART },
      { tab: Tab.SEARCH, tab2: Tab.PERCENTAGE_CHART },
    ],
  ])("normalizes temporary tabs for %s: %j", (tabPaneType, tabs, expected) => {
    const app = { ...defaultAppSettings(), tabPaneType: TabPaneType.SINGLE };
    const view = new GameViewState();
    view.setActive(true, app);
    const manual = {
      ...tabs,
      topPaneHeightPercentage: 55,
      bottomLeftPaneWidthPercentage: 40,
      showCommentInRecordView: true,
    };
    view.update(app, manual);
    const changedApp = { ...app, tabPaneType };
    const original = { ...changedApp };
    view.update(changedApp, {});
    expect(view.settings).toMatchObject({ ...manual, ...expected });
    expect(changedApp).toEqual(original);
  });
});
