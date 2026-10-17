import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RectSize } from "@/common/assets/geometry";
import { t } from "@/common/i18n";
import AnalysisDB from "@/renderer/view/tab/AnalysisDB.vue";
import { Record } from "tsshogi";
import { yaneuraouRepetitionPosition } from "@/tests/helpers/usi";
import { USI_PV_ENDS } from "@/common/game/usi";

const storeMock = vi.hoisted(() => ({
  appState: "normal",
  record: {
    position: {
      sfen: "startpos",
    },
  },
  showPVPreviewDialog: vi.fn(),
}));

const appSettingsMock = vi.hoisted(() => ({
  analysisDBSearchMode: "always",
  analysisDBMaxPVLength: 20,
  nodeCountFormat: "plain",
  evaluationViewFrom: "each",
}));

const confirmShowMock = vi.hoisted(() => vi.fn());
const errorAddMock = vi.hoisted(() => vi.fn());

vi.mock("@/renderer/store", () => ({
  useStore: () => storeMock,
}));
vi.mock("@/renderer/store/settings", () => ({
  useAppSettings: () => appSettingsMock,
}));
vi.mock("@/renderer/store/confirm", () => ({
  useConfirmationStore: () => ({ show: confirmShowMock }),
}));
vi.mock("@/renderer/store/error", () => ({
  useErrorStore: () => ({ add: errorAddMock }),
}));

describe("AnalysisDB", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    storeMock.record.position = { sfen: "startpos" };
    appSettingsMock.analysisDBMaxPVLength = 20;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  const mockResult = (pv: string) => {
    storeMock.record.position = (Record.newByUSI(yaneuraouRepetitionPosition) as Record).position;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            engine_id: 1,
            engine_name: "YaneuraOu",
            multipv: 4,
            depth: 8,
            seldepth: 12,
            nodes: 33863,
            score_cp: 0,
            score_mate: null,
            score_bound: "exact",
            pv,
            updated_at: 0,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  it("shows a busy state while an automatic search is debounced", async () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;

    const wrapper = mount(AnalysisDB, {
      props: {
        size: new RectSize(320, 240),
      },
      global: {
        stubs: {
          Icon: true,
        },
      },
    });

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain(t.noDataInAnalysisDB);
    await vi.advanceTimersByTimeAsync(299);
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain(t.noDataInAnalysisDB);

    wrapper.unmount();
  });

  it("shows a tab-local timeout message after ten seconds", async () => {
    globalThis.fetch = vi.fn((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    const wrapper = mount(AnalysisDB, {
      props: {
        size: new RectSize(320, 240),
      },
      global: {
        stubs: {
          Icon: true,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(9999);
    expect(wrapper.text()).not.toContain(t.analysisDBSearchTimedOut);

    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(wrapper.text()).toContain(t.analysisDBSearchTimedOut);
    expect(wrapper.text()).toContain(t.search);
    expect(errorAddMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("shows a tab-local failure message for non-timeout responses", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("failed", { status: 500 })) as unknown as typeof fetch;

    const wrapper = mount(AnalysisDB, {
      props: {
        size: new RectSize(320, 240),
      },
      global: {
        stubs: {
          Icon: true,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(wrapper.text()).toContain(t.analysisDBSearchFailed);
    expect(errorAddMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it.each([
    ["6b5a rep_draw", "☖５一玉 （千日手）", true],
    ["win", "（宣言勝ち）", false],
    ["resign", "（投了）", false],
  ])("renders stored PV %s with the same ending labels", async (pv, text, playable) => {
    mockResult(pv);
    const wrapper = mount(AnalysisDB, {
      props: { size: new RectSize(320, 240) },
      global: { stubs: { Icon: true } },
    });
    try {
      await vi.advanceTimersByTimeAsync(300);
      await nextTick();
      expect(wrapper.text()).toContain(text);
      expect(wrapper.find("tbody .text button:not(.icon-only)").exists()).toBe(playable);
    } finally {
      wrapper.unmount();
    }
  });

  describe.each([false, true])("PV preview (mobile=%s)", (mobileLayout) => {
    it.each(USI_PV_ENDS)("passes %s separately from all preview moves", async (end) => {
      mockResult(`6b5a 7g7f ${end}`);
      appSettingsMock.analysisDBMaxPVLength = 1;
      const wrapper = mount(AnalysisDB, {
        props: { size: new RectSize(320, 240), mobileLayout },
        global: { stubs: { Icon: true } },
      });
      try {
        await vi.advanceTimersByTimeAsync(300);
        await wrapper.get("tbody .text button:not(.icon-only),.play-button").trigger("click");
        const request = storeMock.showPVPreviewDialog.mock.lastCall?.[0];
        expect(request.pv.map((move: { usi: string }) => move.usi)).toEqual(["6b5a", "7g7f"]);
        expect(request.pvEnd).toBe(end);
      } finally {
        wrapper.unmount();
      }
    });

    it.each([
      "6b5a invalid rep_draw",
      "6b5a 7g7h rep_draw",
      "6b5a rep_draw 7g7f",
      "6b5a rep_unknown",
      "6b5a",
    ])("does not pass an ending for PV %s", async (pv) => {
      mockResult(pv);
      const wrapper = mount(AnalysisDB, {
        props: { size: new RectSize(320, 240), mobileLayout },
        global: { stubs: { Icon: true } },
      });
      try {
        await vi.advanceTimersByTimeAsync(300);
        await wrapper.get("tbody .text button:not(.icon-only),.play-button").trigger("click");
        const request = storeMock.showPVPreviewDialog.mock.lastCall?.[0];
        expect(request.pv.map((move: { usi: string }) => move.usi)).toEqual(["6b5a"]);
        expect(request.pvEnd).toBeUndefined();
      } finally {
        wrapper.unmount();
      }
    });
  });

  it("shows an error dialog when deleting a record fails", async () => {
    globalThis.fetch = vi.fn((_input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(new Response("failed", { status: 500 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              engine_id: 1,
              engine_name: "test",
              multipv: 1,
              depth: 10,
              seldepth: null,
              nodes: null,
              score_cp: null,
              score_mate: null,
              score_bound: "exact",
              pv: null,
              updated_at: 0,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const wrapper = mount(AnalysisDB, {
      props: {
        size: new RectSize(320, 240),
      },
      global: {
        stubs: {
          Icon: true,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    await wrapper.find("button.icon-only").trigger("click");

    const confirmation = confirmShowMock.mock.calls[0]?.[0] as
      { onOk: () => Promise<void> } | undefined;
    expect(confirmation).toBeDefined();

    await confirmation!.onOk();
    expect(errorAddMock).toHaveBeenCalledOnce();

    wrapper.unmount();
  });
});
