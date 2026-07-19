import { shallowMount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { InitialPositionSFEN } from "tsshogi";
import InitialPositionMenu from "@/renderer/view/menu/InitialPositionMenu.vue";

vi.mock("@/renderer/helpers/dialog", () => ({ showModalDialog: vi.fn() }));
vi.mock("@/renderer/devices/hotkey", () => ({
  installHotKeyForDialog: vi.fn(),
  uninstallHotKeyForDialog: vi.fn(),
}));

describe("InitialPositionMenu", () => {
  it("emits the selected SFEN without mutating the global store", async () => {
    const wrapper = shallowMount(InitialPositionMenu, {
      global: { stubs: { Icon: true } },
    });

    await wrapper.findAll("button")[1].trigger("click");

    expect(wrapper.emitted("select")?.[0]).toEqual([InitialPositionSFEN.STANDARD]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
