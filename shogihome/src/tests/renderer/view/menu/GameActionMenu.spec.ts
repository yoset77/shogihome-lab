import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/common/i18n";
import { JishogiRule } from "@/common/settings/game";
import GameActionMenu from "@/renderer/view/menu/GameActionMenu.vue";

const { storeMock } = vi.hoisted(() => ({
  storeMock: {
    isMovableByUser: true,
    gameSettings: { jishogiRule: "general27", repeat: 2 },
    declareWin: vi.fn(),
    showJishogiPoints: vi.fn(),
    showGameResults: vi.fn(),
  },
}));

vi.mock("@/renderer/store", () => ({ useStore: () => storeMock }));
vi.mock("@/renderer/helpers/dialog", () => ({ showModalDialog: vi.fn() }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForDialog: vi.fn(),
  uninstallHotKeyForDialog: vi.fn(),
}));

describe("GameActionMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.isMovableByUser = true;
    storeMock.gameSettings.jishogiRule = JishogiRule.GENERAL27;
    storeMock.gameSettings.repeat = 2;
  });

  it("provides the original actions and closes after a selection", async () => {
    const actions = [
      [t.declareWin, storeMock.declareWin],
      [t.jishogiPoints, storeMock.showJishogiPoints],
      [t.displayGameResults, storeMock.showGameResults],
    ] as const;
    for (const [label, action] of actions) {
      const wrapper = shallowMount(GameActionMenu);
      const button = wrapper.findAll("button").find((item) => item.text().includes(label));
      expect(button?.exists()).toBe(true);
      await button!.trigger("click");
      expect(action).toHaveBeenCalledTimes(1);
      expect(wrapper.emitted("close")).toHaveLength(1);
      wrapper.unmount();
    }
  });

  it("hides win declaration off the human turn or under an ineligible rule", () => {
    storeMock.isMovableByUser = false;
    let wrapper = shallowMount(GameActionMenu);
    expect(wrapper.text()).not.toContain(t.declareWin);
    expect(wrapper.text()).toContain(t.jishogiPoints);
    wrapper.unmount();

    storeMock.isMovableByUser = true;
    storeMock.gameSettings.jishogiRule = JishogiRule.NONE;
    storeMock.gameSettings.repeat = 1;
    wrapper = shallowMount(GameActionMenu);
    expect(wrapper.text()).not.toContain(t.declareWin);
    expect(wrapper.text()).not.toContain(t.displayGameResults);
    expect(wrapper.text()).toContain(t.jishogiPoints);
    wrapper.unmount();
  });
});
