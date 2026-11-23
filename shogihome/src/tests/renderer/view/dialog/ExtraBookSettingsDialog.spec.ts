import { flushPromises, shallowMount } from "@vue/test-utils";
import { emptyUSIEngineExtraBookConfig } from "@/common/settings/usi";
import api from "@/renderer/ipc/api";
import ExtraBookSettingsDialog from "@/renderer/view/dialog/ExtraBookSettingsDialog.vue";

vi.mock("@/renderer/ipc/api");

describe("ExtraBookSettingsDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mountDialog = (config = emptyUSIEngineExtraBookConfig()) =>
    shallowMount(ExtraBookSettingsDialog, {
      props: { config },
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
    });

  const getInput = (wrapper: ReturnType<typeof mountDialog>, label: string) =>
    wrapper
      .findAll(".form-item")
      .find((item) => item.get(".form-item-label").text() === label)!
      .get<HTMLInputElement>("input");

  const moveLimitLabel = "定跡利用手数（0で制限なし）";
  const depthLimitLabel = "最小定跡深さ（0で制限なし）";
  const evaluationLabels = ["最小評価値（先手）", "最小評価値（後手）", "最大評価値差"];

  it("displays missing move and depth limits as zero and unset evaluation limits as blank", () => {
    const wrapper = mountDialog({
      ...emptyUSIEngineExtraBookConfig(),
      maxMoves: undefined,
      bookDepthLimit: undefined,
    });

    for (const label of [moveLimitLabel, depthLimitLabel]) {
      const input = getInput(wrapper, label);
      expect(input.element.value).toBe("0");
      expect(input.element.labels?.[0]?.textContent).toBe(label);
      expect(input.attributes("placeholder")).toBe("制限なし");
    }
    for (const label of evaluationLabels) {
      const input = getInput(wrapper, label);
      expect(input.element.value).toBe("");
      expect(input.attributes("placeholder")).toBe("制限なし");
    }
    wrapper.unmount();
  });

  it("saves cleared move and depth limits as zero without treating zero evaluation limits as blank", async () => {
    const wrapper = mountDialog({
      ...emptyUSIEngineExtraBookConfig(),
      maxMoves: 20,
      bookDepthLimit: 10,
    });

    const maxMoves = getInput(wrapper, moveLimitLabel);
    const minDepth = getInput(wrapper, depthLimitLabel);
    expect(maxMoves.element.value).toBe("20");
    expect(minDepth.element.value).toBe("10");
    await maxMoves.setValue("");
    await minDepth.setValue("");
    await getInput(wrapper, evaluationLabels[0]).setValue("0");
    await getInput(wrapper, evaluationLabels[2]).setValue("0");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");

    expect(wrapper.emitted("ok")).toEqual([
      [
        expect.objectContaining({
          maxMoves: 0,
          bookDepthLimit: 0,
          minEvalBlack: 0,
          minEvalWhite: undefined,
          maxEvalDiff: 0,
        }),
      ],
    ]);
    wrapper.unmount();
  });

  it.each([
    { file: "book.sbk", score: false, depth: false },
    { file: "book.bin", score: true, depth: false },
    { file: "without-depth.ybb", score: true, depth: false },
    { file: "with-depth.ybb", score: true, depth: true },
  ])("disables unsupported limits without clearing their saved values ($file)", async (book) => {
    const config = {
      ...emptyUSIEngineExtraBookConfig(),
      filePath: `server://${book.file}`,
      minEvalBlack: -50,
      minEvalWhite: -100,
      maxEvalDiff: 0,
      bookDepthLimit: 12,
      maxMoves: 20,
    };
    vi.mocked(api.getBookFilterCapabilities).mockResolvedValue({
      score: book.score,
      depth: book.depth,
    });
    const wrapper = mountDialog(config);
    await flushPromises();

    expect(api.getBookFilterCapabilities).toHaveBeenCalledWith(config.filePath);
    for (const label of evaluationLabels) {
      expect(getInput(wrapper, label).element.disabled).toBe(!book.score);
    }
    expect(getInput(wrapper, depthLimitLabel).element.disabled).toBe(!book.depth);
    expect(getInput(wrapper, moveLimitLabel).element.disabled).toBe(false);
    expect(getInput(wrapper, "定跡不使用率").element.disabled).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(wrapper.emitted("ok")).toEqual([[config]]);
    wrapper.unmount();
  });

  it("keeps limits editable if the selected book's capabilities could not be read", async () => {
    vi.mocked(api.getBookFilterCapabilities).mockRejectedValue(new Error("book not found"));
    const wrapper = mountDialog({
      ...emptyUSIEngineExtraBookConfig(),
      filePath: "server://missing.ybb",
    });
    await flushPromises();
    for (const label of [...evaluationLabels, depthLimitLabel]) {
      expect(getInput(wrapper, label).element.disabled).toBe(false);
    }
    wrapper.unmount();
  });
});
