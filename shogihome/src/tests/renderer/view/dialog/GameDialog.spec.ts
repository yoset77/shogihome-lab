import { flushPromises, shallowMount } from "@vue/test-utils";
import { ref } from "vue";
import GameDialog from "@/renderer/view/dialog/GameDialog.vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import GameSaveDirectory from "@/renderer/view/dialog/GameSaveDirectory.vue";
import { defaultGameSettings } from "@/common/settings/game";
import { t } from "@/common/i18n";
import { Language } from "@/common/i18n/languages";

const mocks = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn(), error: vi.fn(), close: vi.fn() }));
vi.mock("@/renderer/store", () => ({
  useStore: () => ({ startGame: mocks.start, closeModalDialog: mocks.close }),
}));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));
vi.mock("@/renderer/store/settings", () => ({ useAppSettings: () => ({ language: Language.JA }) }));
vi.mock("@/renderer/store/lan", () => ({
  useLanStore: () => ({ status: ref("connected"), engineList: ref([]) }),
}));
vi.mock("@/renderer/ipc/api", () => ({
  default: {
    loadGameSettings: mocks.load,
    listServerPosition: async () => [],
    listServerBook: async () => [],
  },
}));

describe("game settings dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue({
      ...defaultGameSettings(),
      repeat: 4,
      black: { uri: "lan-engine:black", name: "Black" },
      white: { uri: "lan-engine:white", name: "White" },
    });
  });
  const mountDialog = () =>
    shallowMount(GameDialog, {
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
    });
  const toggle = (wrapper: ReturnType<typeof mountDialog>, label: string) =>
    wrapper.findAllComponents(ToggleButton).find((toggle) => toggle.props("label") === label);
  const background = (wrapper: ReturnType<typeof mountDialog>) => toggle(wrapper, t.jobsBackground);
  it("passes the edited auto-save directory to the game start", async () => {
    mocks.load.mockResolvedValueOnce({
      ...defaultGameSettings(),
      enableAutoSave: true,
      autoSaveDirectory: "server://saved",
    });
    const wrapper = mountDialog();
    await flushPromises();
    const picker = wrapper.getComponent(GameSaveDirectory);
    expect(picker.props()).toMatchObject({ value: "server://saved", disabled: false });
    picker.vm.$emit("update:value", "server://next");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ enableAutoSave: true, autoSaveDirectory: "server://next" }),
      false,
    );
    wrapper.unmount();
  });

  it("does not start or persist edited settings when cancelled", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.getComponent(GameSaveDirectory).props("disabled")).toBe(true);
    wrapper.getComponent(GameSaveDirectory).vm.$emit("update:value", "server://cancelled");
    await wrapper.get('button[data-hotkey="Escape"]').trigger("click");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("defaults to serial and forces parallel games into the background", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#game-parallelism").element.value).toBe("1");
    expect(background(wrapper)!.props("disabled")).toBe(false);
    await wrapper.get("#game-parallelism").setValue("4");
    expect(background(wrapper)!.props()).toMatchObject({ disabled: true, value: true });
    expect(wrapper.text()).toContain(t.parallelGameNote);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ parallelism: 4 }), true);
    await wrapper.get("#game-parallelism").setValue("1");
    expect(background(wrapper)!.props()).toMatchObject({ disabled: false, value: false });
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ parallelism: 1 }),
      false,
    );
    wrapper.unmount();
  });
  it.each([0, 1])(
    "uses one serial game when player %i is human and restores engine settings",
    async (playerIndex) => {
      const wrapper = mountDialog();
      await flushPromises();
      await wrapper.get("#game-repeat").setValue("6");
      await wrapper.get("#game-parallelism").setValue("4");
      const swap = toggle(wrapper, t.swapTurnWhenGameRepetition)!;
      swap.vm.$emit("update:value", true);
      const player = wrapper.findAllComponents(PlayerSelector)[playerIndex];
      player.vm.$emit("update:playerUri", "es://human");
      await flushPromises();
      expect(wrapper.find("#game-repeat").exists()).toBe(false);
      expect(wrapper.find("#game-parallelism").exists()).toBe(false);
      expect(toggle(wrapper, t.swapTurnWhenGameRepetition)).toBeUndefined();
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ repeat: 1, parallelism: 1, swapPlayers: true }),
        false,
      );
      player.vm.$emit(
        "update:playerUri",
        playerIndex === 0 ? "lan-engine:black" : "lan-engine:white",
      );
      await flushPromises();
      expect(wrapper.get<HTMLInputElement>("#game-repeat").element.value).toBe("6");
      expect(wrapper.get<HTMLInputElement>("#game-parallelism").element.value).toBe("4");
      expect(toggle(wrapper, t.swapTurnWhenGameRepetition)!.props()).toMatchObject({
        value: true,
        disabled: false,
      });
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.start).toHaveBeenLastCalledWith(
        expect.objectContaining({ repeat: 6, parallelism: 4, swapPlayers: true }),
        true,
      );
      wrapper.unmount();
    },
  );

  it.each([
    { black: "es://human", white: "es://human", swap: false, humanFront: false },
    { black: "es://human", white: "lan-engine:white", swap: false, humanFront: true },
    { black: "lan-engine:black", white: "es://human", swap: false, humanFront: true },
    { black: "lan-engine:black", white: "lan-engine:white", swap: true, humanFront: false },
  ])(
    "shows only applicable player toggles for $black vs $white",
    async ({ black, white, swap, humanFront }) => {
      mocks.load.mockResolvedValueOnce({
        ...defaultGameSettings(),
        black: { uri: black, name: "Black" },
        white: { uri: white, name: "White" },
        swapPlayers: true,
        humanIsFront: true,
      });
      const wrapper = mountDialog();
      await flushPromises();
      expect(!!toggle(wrapper, t.swapTurnWhenGameRepetition)).toBe(swap);
      expect(!!toggle(wrapper, t.adjustBoardToHumanPlayer)).toBe(humanFront);
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ swapPlayers: true, humanIsFront: true }),
        false,
      );
      wrapper.unmount();
    },
  );

  it.each([false, true])(
    "preserves the edited human-front setting %s while hidden",
    async (value) => {
      mocks.load.mockResolvedValueOnce({
        ...defaultGameSettings(),
        white: { uri: "lan-engine:white", name: "White" },
        humanIsFront: !value,
      });
      const wrapper = mountDialog();
      await flushPromises();
      toggle(wrapper, t.adjustBoardToHumanPlayer)!.vm.$emit("update:value", value);
      await wrapper.get(".players-control button").trigger("click");
      expect(toggle(wrapper, t.adjustBoardToHumanPlayer)!.props("value")).toBe(value);
      const players = wrapper.findAllComponents(PlayerSelector);
      players[1].vm.$emit("update:playerUri", "lan-engine:white");
      await flushPromises();
      expect(toggle(wrapper, t.adjustBoardToHumanPlayer)).toBeUndefined();
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.start).toHaveBeenLastCalledWith(
        expect.objectContaining({ humanIsFront: value }),
        false,
      );
      players[0].vm.$emit("update:playerUri", "es://human");
      await flushPromises();
      expect(toggle(wrapper, t.adjustBoardToHumanPlayer)!.props("value")).toBe(value);
      players[1].vm.$emit("update:playerUri", "es://human");
      await flushPromises();
      expect(toggle(wrapper, t.adjustBoardToHumanPlayer)).toBeUndefined();
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.start).toHaveBeenLastCalledWith(
        expect.objectContaining({ humanIsFront: value }),
        false,
      );
      players[1].vm.$emit("update:playerUri", "lan-engine:white");
      await flushPromises();
      expect(toggle(wrapper, t.adjustBoardToHumanPlayer)!.props("value")).toBe(value);
      expect(mocks.error).not.toHaveBeenCalled();
      wrapper.unmount();
    },
  );

  it("ignores a saved repetition count when both players are human", async () => {
    const saved = { ...defaultGameSettings(), repeat: 4 };
    mocks.load.mockResolvedValueOnce(saved);
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find("#game-repeat").exists()).toBe(false);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ repeat: 1 }), false);
    expect(saved.repeat).toBe(4);
    wrapper.unmount();
  });

  it.each([
    {
      side: "black",
      byoyomiID: "#game-byoyomi",
      incrementID: "#game-increment",
      timeKey: "timeLimit",
      initialByoyomi: "30",
    },
    {
      side: "white",
      byoyomiID: "#game-white-byoyomi",
      incrementID: "#game-white-increment",
      timeKey: "whiteTimeLimit",
      initialByoyomi: "10",
    },
  ])(
    "keeps byoyomi and increment mutually exclusive for $side",
    async ({ byoyomiID, incrementID, timeKey, initialByoyomi }) => {
      const saved = {
        ...defaultGameSettings(),
        timeLimit: { timeSeconds: 600, byoyomi: 30, increment: 0 },
        whiteTimeLimit: { timeSeconds: 300, byoyomi: 10, increment: 0 },
      };
      mocks.load.mockResolvedValueOnce(saved);
      const wrapper = mountDialog();
      await flushPromises();
      const byoyomi = wrapper.get<HTMLInputElement>(byoyomiID);
      const increment = wrapper.get<HTMLInputElement>(incrementID);
      const otherByoyomi = wrapper.get<HTMLInputElement>(
        timeKey === "timeLimit" ? "#game-white-byoyomi" : "#game-byoyomi",
      );
      const otherIncrement = wrapper.get<HTMLInputElement>(
        timeKey === "timeLimit" ? "#game-white-increment" : "#game-increment",
      );
      const otherInitialByoyomi = otherByoyomi.element.value;

      await increment.setValue("");
      expect(byoyomi.element.value).toBe(initialByoyomi);
      await increment.setValue("0");
      expect(byoyomi.element.value).toBe(initialByoyomi);
      await increment.setValue("1");
      expect(byoyomi.element.value).toBe("0");
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [timeKey]: expect.objectContaining({ byoyomi: 0, increment: 1 }),
        }),
        false,
      );

      await byoyomi.setValue("");
      expect(increment.element.value).toBe("1");
      await byoyomi.setValue("0");
      expect(increment.element.value).toBe("1");
      await byoyomi.setValue("1");
      expect(increment.element.value).toBe("0");
      await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
      expect(mocks.start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [timeKey]: expect.objectContaining({ byoyomi: 1, increment: 0 }),
        }),
        false,
      );
      expect(otherByoyomi.element.value).toBe(otherInitialByoyomi);
      expect(otherIncrement.element.value).toBe("0");
      expect(mocks.error).not.toHaveBeenCalled();
      wrapper.unmount();
    },
  );

  it("preserves both time settings when loading and swapping different time controls", async () => {
    const saved = {
      ...defaultGameSettings(),
      timeLimit: { timeSeconds: 600, byoyomi: 30, increment: 0 },
      whiteTimeLimit: { timeSeconds: 300, byoyomi: 0, increment: 5 },
    };
    mocks.load.mockResolvedValueOnce(saved);
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeLimit: saved.timeLimit, whiteTimeLimit: saved.whiteTimeLimit }),
      false,
    );
    await wrapper.get(".players-control button").trigger("click");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeLimit: saved.whiteTimeLimit, whiteTimeLimit: saved.timeLimit }),
      false,
    );
    expect(mocks.error).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("uses shared time settings when separate white time settings are disabled", async () => {
    mocks.load.mockResolvedValueOnce({
      ...defaultGameSettings(),
      timeLimit: { timeSeconds: 600, byoyomi: 30, increment: 0 },
    });
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#game-white-increment").element.disabled).toBe(true);
    await wrapper.get("#game-increment").setValue("5");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ timeLimit: { timeSeconds: 600, byoyomi: 0, increment: 5 } }),
      false,
    );
    expect(mocks.start.mock.lastCall?.[0]).not.toHaveProperty("whiteTimeLimit");
    wrapper.unmount();
  });

  it.each(["", "0", "1.5", "17"])("rejects invalid parallelism '%s'", async (value) => {
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.get("#game-parallelism").setValue(value);
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.error).toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
