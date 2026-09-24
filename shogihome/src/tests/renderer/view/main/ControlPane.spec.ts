import { shallowMount } from "@vue/test-utils";
import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/common/i18n";
import { AppState, ResearchState } from "@/common/control/state";
import { JishogiRule } from "@/common/settings/game";
import ControlPane, { ControlGroup } from "@/renderer/view/main/ControlPane.vue";
import GameActionMenu from "@/renderer/view/menu/GameActionMenu.vue";

const { storeMock } = vi.hoisted(() => ({
  storeMock: {
    appState: "game",
    researchState: "idle",
    supportsTakeback: true,
    canTakeback: true,
    isTakingBack: false,
    isMovableByUser: true,
    gameSettings: { jishogiRule: "general27", repeat: 1 },
    takeback: vi.fn(),
    stopGame: vi.fn(),
    resign: vi.fn(),
    declareWin: vi.fn(),
    showJishogiPoints: vi.fn(),
    showGameResults: vi.fn(),
  },
}));

const store = reactive(storeMock);

vi.mock("@/renderer/store", () => ({ useStore: () => store }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({}) }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({}) }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForMainWindow: vi.fn(),
  uninstallHotKeyForMainWindow: vi.fn(),
}));

describe("ControlPane game actions", () => {
  beforeEach(() => {
    storeMock.appState = AppState.GAME;
    storeMock.researchState = ResearchState.IDLE;
    storeMock.supportsTakeback = true;
    storeMock.canTakeback = true;
    storeMock.isTakingBack = false;
    storeMock.isMovableByUser = true;
    storeMock.gameSettings.jishogiRule = JishogiRule.GENERAL27;
    storeMock.gameSettings.repeat = 1;
  });

  it("keeps five visible buttons during a human-versus-engine takeback game", async () => {
    const wrapper = shallowMount(ControlPane, {
      props: { group: ControlGroup.Group1 },
    });
    const buttons = wrapper.findAll(".control-box > button");
    expect(
      buttons.filter((button) => (button.element as HTMLElement).style.display !== "none"),
    ).toHaveLength(5);
    expect(wrapper.text()).toContain(t.others);
    expect(wrapper.findComponent(GameActionMenu).exists()).toBe(false);
    const more = buttons.find((button) => button.text().includes(t.others));
    expect(more?.exists()).toBe(true);
    await more!.trigger("click");
    expect(wrapper.findComponent(GameActionMenu).exists()).toBe(true);
    wrapper.findComponent(GameActionMenu).vm.$emit("close");
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(GameActionMenu).exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the actions compact during an engine-versus-engine repeated game", () => {
    storeMock.supportsTakeback = false;
    storeMock.canTakeback = false;
    storeMock.isMovableByUser = false;
    storeMock.gameSettings.repeat = 2;
    const wrapper = shallowMount(ControlPane, { props: { group: ControlGroup.Group1 } });
    const buttons = wrapper.findAll(".control-box > button");
    expect(
      buttons.filter((button) => (button.element as HTMLElement).style.display !== "none"),
    ).toHaveLength(3);
    expect(wrapper.text()).toContain(t.others);
    wrapper.unmount();
  });

  it("closes the game actions when the game ends", async () => {
    const wrapper = shallowMount(ControlPane, { props: { group: ControlGroup.Group1 } });
    const more = wrapper
      .findAll(".control-box > button")
      .find((button) => button.text().includes(t.others));
    await more!.trigger("click");
    expect(wrapper.findComponent(GameActionMenu).exists()).toBe(true);

    store.appState = AppState.NORMAL;
    await wrapper.vm.$nextTick();
    store.appState = AppState.GAME;
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(GameActionMenu).exists()).toBe(false);
    wrapper.unmount();
  });
});
