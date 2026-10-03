import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { RectSize } from "@/common/assets/geometry";
import { AppState, ResearchState } from "@/common/control/state";
import { defaultAppSettings } from "@/common/settings/app";
import MobileLayout from "@/renderer/view/main/MobileLayout.vue";
import BoardPane from "@/renderer/view/main/BoardPane.vue";
import MobileControls from "@/renderer/view/main/MobileControls.vue";
import RecordPane from "@/renderer/view/main/RecordPane.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import EngineAnalytics from "@/renderer/view/tab/EngineAnalytics.vue";
import PuzzlePane from "@/renderer/view/tab/PuzzlePane.vue";
import RecordComment from "@/renderer/view/tab/RecordComment.vue";
import RecordInfo from "@/renderer/view/tab/RecordInfo.vue";

const { useStore, useAppSettings } = vi.hoisted(() => ({
  useStore: vi.fn(),
  useAppSettings: vi.fn(),
}));

vi.mock("@/renderer/store", () => ({ useStore }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings }));
vi.mock("@/renderer/ipc/api", () => ({
  default: {},
  appInfo: {},
  isIOS: () => false,
  isMobileWebApp: () => true,
  isNative: () => false,
}));

const settings = reactive(defaultAppSettings());
const store = reactive({
  appState: AppState.NORMAL,
  researchState: ResearchState.IDLE,
  puzzle: undefined as { type: string } | undefined,
});
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
};
const resizeViewport = async (width: number, height: number) => {
  setViewport(width, height);
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(80);
  await nextTick();
};
const mountLayout = () =>
  shallowMount(MobileLayout, { global: { stubs: { HorizontalSelector: false } } });
type LayoutWrapper = ReturnType<typeof mountLayout>;
const selectTab = async (wrapper: LayoutWrapper, value: string) => {
  wrapper.getComponent(HorizontalSelector).vm.$emit("update:value", value);
  await nextTick();
};
const reportBoardSize = async (wrapper: LayoutWrapper, width: number, height: number) => {
  wrapper.getComponent(BoardPane).vm.$emit("resize", new RectSize(width, height));
  await nextTick();
};
const expectNonnegativeSizes = (wrapper: LayoutWrapper) => {
  const boardSize = wrapper.getComponent(BoardPane).props("maxSize") as RectSize;
  const bottomSize = wrapper.getComponent(RecordInfo).props("size") as RectSize;
  for (const size of [boardSize, bottomSize]) {
    expect(size.width).toBeGreaterThanOrEqual(0);
    expect(size.height).toBeGreaterThanOrEqual(0);
  }
};

enableAutoUnmount(afterEach);

describe("MobileLayout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setViewport(390, 844);
    Object.assign(settings, defaultAppSettings());
    store.appState = AppState.NORMAL;
    store.researchState = ResearchState.IDLE;
    store.puzzle = undefined;
    useStore.mockReturnValue(store);
    useAppSettings.mockReturnValue(settings);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setViewport(originalViewport.width, originalViewport.height);
  });

  it.each([
    [390, 844],
    [844, 390],
    [600, 600],
  ])("uses a single vertical stack at %i x %i", (width, height) => {
    setViewport(width, height);
    const wrapper = mountLayout();
    const board = wrapper.getComponent(BoardPane).element;
    const controls = wrapper.getComponent(MobileControls).element;
    const record = wrapper.getComponent(RecordPane).element;
    const selector = wrapper.getComponent(HorizontalSelector).element;

    expect(wrapper.findAllComponents(RecordPane)).toHaveLength(1);
    expect(wrapper.findAllComponents(MobileControls)).toHaveLength(1);
    expect(wrapper.findAllComponents(HorizontalSelector)).toHaveLength(1);
    expect(board.parentElement?.classList.contains("column")).toBe(true);
    for (const element of [controls, record, selector]) {
      expect(element.parentElement).toBe(board.parentElement);
    }
    expect(board.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(controls.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(record.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("preserves portrait sizing", async () => {
    const wrapper = mountLayout();
    const height = 844 - 10;
    const controlHeight = Math.min(height * 0.08, 390 * 0.12);

    expect(wrapper.getComponent(BoardPane).props("maxSize")).toEqual(
      new RectSize(390, height - controlHeight - 130),
    );
    await reportBoardSize(wrapper, 390, 500);
    expect(wrapper.getComponent(RecordInfo).props("size")).toEqual(
      new RectSize(390, height - 500 - controlHeight - 30),
    );
  });

  describe.each([ResearchState.IDLE, ResearchState.STARTUP_DIALOG])(
    "research starting from %s",
    (initialState) => {
      it.each(["record", "comment", "info", "analysisDB", "book"])(
        "switches the %s tab to PV after startup succeeds",
        async (tab) => {
          settings.showBookTableOnMobile = true;
          store.researchState = initialState;
          const wrapper = mountLayout();
          await selectTab(wrapper, tab);

          store.researchState = ResearchState.RUNNING;
          await nextTick();

          expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe("pv");
          expect(wrapper.getComponent(EngineAnalytics).props("historyMode")).toBe(false);
        },
      );

      it.each(["pv", "search", "chart"])("preserves the %s tab", async (tab) => {
        settings.showSearchLogOnMobile = true;
        store.researchState = initialState;
        const wrapper = mountLayout();
        await selectTab(wrapper, tab);

        store.researchState = ResearchState.RUNNING;
        await nextTick();

        expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe(tab);
      });
    },
  );

  it("switches a disabled search tab to PV when research starts", async () => {
    settings.showSearchLogOnMobile = true;
    const wrapper = mountLayout();
    await selectTab(wrapper, "search");
    settings.showSearchLogOnMobile = false;
    await nextTick();

    store.researchState = ResearchState.RUNNING;
    await nextTick();

    expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe("pv");
  });

  it("preserves the tab when opening or cancelling startup and when startup fails", async () => {
    const wrapper = mountLayout();
    await selectTab(wrapper, "comment");

    for (const state of [
      ResearchState.STARTUP_DIALOG,
      ResearchState.IDLE,
      ResearchState.STARTUP_DIALOG,
    ]) {
      store.researchState = state;
      await nextTick();
      expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe("comment");
    }
  });

  it("preserves manual selection through pause, resume and stop, but switches on restart", async () => {
    const wrapper = mountLayout();
    store.researchState = ResearchState.RUNNING;
    await nextTick();
    await selectTab(wrapper, "record");

    for (const state of [
      ResearchState.PAUSED,
      ResearchState.RUNNING,
      ResearchState.STOPPING,
      ResearchState.IDLE,
    ]) {
      store.researchState = state;
      await nextTick();
      expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe("record");
    }

    store.researchState = ResearchState.RUNNING;
    await nextTick();
    expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe("pv");
  });

  it("does not switch tabs on mount even if research is already running", () => {
    store.researchState = ResearchState.RUNNING;
    const wrapper = mountLayout();
    expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe("record");
  });

  it("reveals the PV tab after automatically switching without scrolling on manual selection", async () => {
    const wrapper = mountLayout();
    const selector = wrapper.getComponent(HorizontalSelector);
    const root = selector.element as HTMLElement;
    const pv = selector.get('input[value="pv"]').element.parentElement!;
    root.scrollLeft = 400;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 30));
    vi.spyOn(pv, "getBoundingClientRect").mockReturnValue(new DOMRect(-300, 0, 80, 30));

    await selectTab(wrapper, "comment");
    expect(root.scrollLeft).toBe(400);
    store.researchState = ResearchState.RUNNING;
    await nextTick();
    await nextTick();

    expect(selector.props("value")).toBe("pv");
    expect(root.scrollLeft).toBe(100);
  });

  it.each([
    ["comment", RecordComment],
    ["pv", EngineAnalytics],
  ] as const)(
    "keeps the %s tab and component when rotating and returning",
    async (tab, component) => {
      const wrapper = mountLayout();
      await selectTab(wrapper, tab);
      const selected = wrapper.getComponent(component);
      expect((selected.element as HTMLElement).style.display).not.toBe("none");
      const board = wrapper.getComponent(BoardPane).vm;
      const controls = wrapper.getComponent(MobileControls).vm;

      for (const [width, height] of [
        [844, 390],
        [390, 844],
      ]) {
        await resizeViewport(width, height);
        expect(wrapper.getComponent(HorizontalSelector).props("value")).toBe(tab);
        expect(wrapper.getComponent(component).vm).toBe(selected.vm);
        expect((wrapper.getComponent(component).element as HTMLElement).style.display).not.toBe(
          "none",
        );
        expect(wrapper.getComponent(BoardPane).vm).toBe(board);
        expect(wrapper.getComponent(MobileControls).vm).toBe(controls);
      }
    },
  );

  it("keeps initial dimensions and stale board feedback nonnegative when shrinking", async () => {
    const wrapper = mountLayout();
    expectNonnegativeSizes(wrapper);
    await reportBoardSize(wrapper, 390, 500);
    await resizeViewport(844, 100);
    expectNonnegativeSizes(wrapper);
    expect(wrapper.getComponent(BoardPane).props("maxSize").height).toBe(0);
    expect(wrapper.getComponent(RecordInfo).props("size").height).toBe(0);
    await resizeViewport(844, 5);
    await reportBoardSize(wrapper, 0, 0);
    expectNonnegativeSizes(wrapper);
  });

  it("keeps evaluation puzzles below the board and handles height shortages", async () => {
    setViewport(844, 390);
    store.appState = AppState.PUZZLE;
    store.puzzle = { type: "evaluation" };
    const wrapper = mountLayout();
    expect(wrapper.findComponent(MobileControls).exists()).toBe(false);
    expect(wrapper.findComponent(HorizontalSelector).exists()).toBe(false);
    const puzzle = wrapper.getComponent(PuzzlePane);
    expect(puzzle.element.parentElement).toBe(
      wrapper.getComponent(BoardPane).element.parentElement,
    );
    await reportBoardSize(wrapper, 200, 200);
    expect(parseFloat((puzzle.element as HTMLElement).style.height)).toBe(390 - 10 - 200);
    await resizeViewport(844, 5);
    expect(parseFloat((puzzle.element as HTMLElement).style.height)).toBe(0);
    expectNonnegativeSizes(wrapper);
  });
});
